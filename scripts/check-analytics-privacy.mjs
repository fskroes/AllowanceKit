#!/usr/bin/env node
// Browser-level privacy regression for the marketing and Cloud analytics loaders.
// All browser requests are intercepted. The official Vercel script is fetched
// into memory, and its event endpoint is mocked locally.
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const walletRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apps = [
  {
    name: 'marketing', host: 'www.onewallie.com',
    root: path.resolve(walletRoot, '../onewallie-site'), base: 'root',
  },
  {
    name: 'cloud', host: 'app.onewallie.com',
    root: path.resolve(walletRoot, '../wallie-cloud'), base: 'public',
  },
];
const [playwrightArg, chromeArg] = process.argv.slice(2);
const playwright = await import(playwrightArg ? pathToFileURL(path.resolve(playwrightArg)) : 'playwright');
const { chromium } = playwright;
assert(chromium, 'Playwright Chromium is required');

// No `referrer` option exists in @vercel/analytics 2.0.1's public inject types.
// Its hosted script adds document.referrer after beforeSend, so beforeSend alone
// cannot redact it. Fetch the official script without saving it to the repo.
const sdkUrl = 'https://va.vercel-scripts.com/v1/script.js';
const sdkResponse = await fetch(sdkUrl, { signal: AbortSignal.timeout(15_000) });
assert(sdkResponse.ok, `Could not fetch official Vercel script: HTTP ${sdkResponse.status}`);
const officialScript = await sdkResponse.text();
assert(officialScript.includes('beforeSend') && officialScript.includes('withReferrer'),
  'Official Vercel script changed; inspect its referrer behavior before updating this test');

const browser = await chromium.launch({
  headless: true,
  ...(chromeArg ? { executablePath: path.resolve(chromeArg) } : {}),
});

function contentType(file) {
  if (file.endsWith('.mjs') || file.endsWith('.js')) return 'text/javascript';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.html')) return 'text/html';
  return 'application/octet-stream';
}

async function serveAppAsset(route, app, pathname) {
  const base = app.base === 'public' ? path.join(app.root, 'public') : app.root;
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(base, relative);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) {
    await route.fulfill({ status: 404, body: 'Not found' });
    return;
  }
  try {
    const body = await readFile(file);
    await route.fulfill({ status: 200, contentType: contentType(file), body });
  } catch {
    await route.fulfill({ status: 404, body: 'Not found' });
  }
}

async function scenario(app, mode) {
  const context = await browser.newContext();
  await context.addInitScript((privacyMode) => {
    // Vercel's production script skips webdriver/headless browsers. Hide those
    // test-only markers so this exercises the production event transport.
    const nativeUserAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get.call(navigator);
    Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true, get: () => nativeUserAgent.replace('HeadlessChrome', 'Chrome'),
    });
    Object.defineProperty(navigator, 'doNotTrack', {
      configurable: true, get: () => privacyMode === 'dnt' ? '1' : null,
    });
    Object.defineProperty(navigator, 'globalPrivacyControl', {
      configurable: true, get: () => privacyMode === 'gpc',
    });
  }, mode);

  const events = [];
  const analyticsRequests = [];
  let resolveView;
  const viewReceived = new Promise((resolve) => { resolveView = resolve; });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'attacker.example') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'Referrer-Policy': 'unsafe-url' },
        body: `<a id="continue" href="https://${app.host}/?token=destination-secret">continue</a>`,
      });
      return;
    }
    if (url.hostname === app.host) {
      if (url.pathname.startsWith('/_vercel/insights/')) analyticsRequests.push(url.pathname);
      if (url.pathname === '/_vercel/insights/script.js') {
        await route.fulfill({ status: 200, contentType: 'text/javascript', body: officialScript });
        return;
      }
      if (url.pathname === '/_vercel/insights/view') {
        const event = JSON.parse(route.request().postData() ?? '{}');
        events.push(event);
        resolveView(event);
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      if (url.pathname.startsWith('/_vercel/insights/')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      await serveAppAsset(route, app, url.pathname);
      return;
    }
    // Do not allow any request to leave the test, including fonts or other CDNs.
    await route.abort();
  });

  const page = await context.newPage();
  if (mode === 'unsafe-referrer') {
    await page.goto('https://attacker.example/reset?token=referrer-secret#private');
    await page.click('#continue');
  } else {
    await page.goto(`https://${app.host}/?email=current-secret`);
  }

  if (mode === 'unsafe-referrer' || mode === 'direct') {
    const event = await Promise.race([
      viewReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${app.name}: analytics event timed out`)), 5_000)),
    ]);
    assert.equal(event.o, `https://${app.host}/`, `${app.name}: current URL must be allowlisted without query data`);
    assert(!JSON.stringify(event).includes('secret'), `${app.name}: sensitive URL data reached transport`);
    if (mode === 'unsafe-referrer') assert.equal(event.r, 'https://attacker.example/', `${app.name}: referrer must be origin only`);
    else assert(!event.r, `${app.name}: direct visit must not include referrer data`);
    await context.close();
    return `${app.name}: ${mode} transport redaction passed`;
  }

  await page.waitForTimeout(200);
  assert.equal(analyticsRequests.length, 0, `${app.name}: ${mode} must prevent analytics requests`);
  assert.equal(events.length, 0, `${app.name}: ${mode} must prevent analytics events`);
  await context.close();
  return `${app.name}: ${mode.toUpperCase()} opt-out passed`;
}

try {
  const results = [];
  for (const app of apps) {
    for (const mode of ['unsafe-referrer', 'direct', 'dnt', 'gpc']) results.push(await scenario(app, mode));
  }
  for (const result of results) console.log(`PASS ${result}`);
  console.log('All browser requests were intercepted; no analytics events were sent externally.');
} finally {
  await browser.close();
}

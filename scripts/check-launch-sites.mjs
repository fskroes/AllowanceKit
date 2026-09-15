/** Browser regression checks for the marketing and Cloud sites. No live mutations. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveStaticSite } from './static-site-server.mjs';

const [siteArg, cloudArg, playwrightArg, outputArg] = process.argv.slice(2);
if (!siteArg || !cloudArg || !playwrightArg) {
  console.error('Usage: node scripts/check-launch-sites.mjs SITE_DIR CLOUD_DIR PLAYWRIGHT_MODULE [REPORT_DIR]');
  process.exit(2);
}
const output = path.resolve(outputArg ?? '/tmp/wallie-launch-checks');
fs.mkdirSync(output, { recursive: true });
const { chromium } = await import(pathToFileURL(path.resolve(playwrightArg)).href);
const site = await serveStaticSite(siteArg);
const cloud = await serveStaticSite(path.join(cloudArg, 'public'), { cleanUrls: true });
const fixtures = JSON.parse(fs.readFileSync(path.join(cloudArg, 'test/browser-fixtures.json'), 'utf8'));
const configs = [
  { name: 'marketing', origin: site.origin, paths: ['/', '/cloud.html', '/docs.html', '/x402-spending-limits.html', '/privacy.html', '/terms.html', '/solana.html'] },
  { name: 'cloud', origin: cloud.origin, paths: ['/', '/overview', '/key', '/events', '/alerts', '/billing', '/welcome'] },
];
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.SUBMISSION_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const report = [];
  for (const width of [320, 360, 390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === cloud.origin && url.pathname.startsWith('/v1/')) {
        const data = fixtures[url.pathname + url.search] ?? fixtures[url.pathname];
        return route.fulfill({ status: data ? 200 : 404, contentType: 'application/json', body: JSON.stringify(data ?? { error: 'Missing browser fixture' }) });
      }
      if (!['GET', 'HEAD'].includes(request.method())) return route.abort('blockedbyclient');
      return route.continue();
    });
    for (const config of configs) {
      for (const pathname of config.paths) {
        const page = await context.newPage();
        const errors = [];
        const failures = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => {
          if (response.url().startsWith(config.origin) && response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
        });
        const response = await page.goto(config.origin + pathname, { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready);
        assert.equal(response.status(), 200, `${config.name} ${pathname}: HTTP status`);
        assert.equal(new URL(page.url()).pathname, pathname, `${config.name} ${pathname}: unexpected redirect`);
        assert(await page.title(), `${config.name} ${pathname}: title`);
        assert(await page.locator('meta[name="description"]').getAttribute('content'), `${pathname}: description`);
        assert(await page.locator('meta[property="og:image"]').getAttribute('content'), `${pathname}: OG image`);
        assert.equal(await page.locator('link[rel="icon"]').count(), 1, `${pathname}: favicon`);
        assert.equal(await page.locator('h1').count(), 1, `${pathname}: heading`);
        if (config.name === 'cloud') assert.match(await page.locator('meta[name="robots"]').getAttribute('content'), /noindex/);
        for (const legal of ['privacy.html', 'terms.html']) assert(await page.locator(`a[href$="/${legal}"]`).count(), `${pathname}: ${legal} link`);
        const actualWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        assert(actualWidth <= width, `${config.name} ${pathname}: ${actualWidth}px overflows ${width}px`);
        for (const img of await page.locator('img').all()) {
          assert(await img.getAttribute('alt'), `${pathname}: image alt`);
          await img.scrollIntoViewIfNeeded();
          await img.evaluate(image => image.decode());
          assert(await img.evaluate(image => image.naturalWidth > 0), `${pathname}: image loaded`);
        }
        if (config.name === 'marketing' && pathname === '/solana.html') {
          assert.equal(await page.locator('video').count(), 0, 'Deferred videos must not make requests');
          await page.locator('a.button[href="#try"]').first().click();
          assert(await page.locator('#install').isVisible());
        }
        await page.evaluate(() => scrollTo(0, 0));
        if (width === 390 && ['/docs.html', '/solana.html', '/overview', '/'].includes(pathname)) {
          await page.screenshot({ path: path.join(output, `${config.name}-${pathname === '/' ? 'home' : pathname.slice(1).replace('.html', '')}-390.png`) });
        }
        assert.deepEqual(errors, [], `${config.name} ${pathname}: page errors`);
        assert.deepEqual(failures, [], `${config.name} ${pathname}: resource errors`);
        report.push({ site: config.name, path: pathname, width, overflow: false, errors });
        await page.close();
      }
      const missing = await context.newPage();
      const response = await missing.goto(config.origin + '/this-page-does-not-exist', { waitUntil: 'networkidle' });
      assert.equal(response.status(), 404, `${config.name}: preserve 404 status`);
      assert.match(await missing.locator('h1').innerText(), /page not found/i);
      assert.match(await missing.locator('meta[name="robots"]').getAttribute('content'), /noindex/);
      await missing.close();
    }
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  let requests = 0;
  let status = 500;
  let release;
  let delay = false;
  await context.route('**/v1/auth/magic-link', async route => {
    requests++;
    if (delay) await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { ok: true } : { error: 'Request failed' }) });
  });
  const page = await context.newPage();
  await page.goto(cloud.origin, { waitUntil: 'networkidle' });
  await page.locator('#submit').click();
  assert.match(await page.locator('#email-error').innerText(), /enter your email/);
  await page.locator('#email').fill('invalid-email');
  await page.locator('#submit').click();
  assert.match(await page.locator('#email-error').innerText(), /valid email/);
  assert.equal(requests, 0, 'Invalid email must never reach the API');
  assert.equal(await page.locator('#email').getAttribute('aria-invalid'), 'true');
  await page.locator('#email').fill('test@example.com');
  assert.equal(await page.locator('#email').getAttribute('aria-invalid'), 'false');
  await page.locator('#submit').click();
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.match(await page.locator('#result').innerText(), /couldn't send/);
  status = 400;
  await page.locator('#submit').click();
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.match(await page.locator('#email-error').innerText(), /valid email/);
  await page.locator('#email').fill('test@example.com');
  status = 200; delay = true;
  await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#submit').disabled);
  assert.match(await page.locator('#submit').innerText(), /Sending/);
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  release();
  await page.waitForFunction(() => document.querySelector('#signin').hidden);
  assert.match(await page.locator('#result').innerText(), /Check your inbox/);
  await page.goto(cloud.origin + '/?error=link', { waitUntil: 'networkidle' });
  assert.match(await page.locator('#urlmsg').innerText(), /invalid or has expired/);
  await context.route('**/v1/account/**', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  const authErrors = [];
  page.on('pageerror', error => authErrors.push(error.message));
  await page.goto(cloud.origin + '/overview', { waitUntil: 'networkidle' });
  await page.waitForURL(cloud.origin + '/');
  assert.deepEqual(authErrors, [], 'Expired sessions redirect without uncaught errors');
  await context.close();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ pages: report, forms: ['empty', 'format before request', 'server 400', 'server failure', 'loading', 'success', 'expired link', 'expired session'], videoChecks: 'Deferred by owner' }, null, 2) + '\n');
  console.log(`PASS: ${report.length} page/viewport checks, branded 404s, sign-in states and expired-session redirects. Videos excluded.`);
} finally {
  await browser?.close();
  await site.close();
  await cloud.close();
}

#!/usr/bin/env node
// Synthetic production transport check. This visits only public pages and
// verifies the real Vercel pageview POST and response.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [playwrightArg, chromeArg] = process.argv.slice(2);
const playwright = await import(playwrightArg ? pathToFileURL(path.resolve(playwrightArg)) : 'playwright');
const { chromium } = playwright;
assert(chromium, 'Playwright Chromium is required');

const browser = await chromium.launch({ headless: true, ...(chromeArg ? { executablePath: path.resolve(chromeArg) } : {}) });
const urls = ['https://www.onewallie.com/', 'https://www.onewallie.com/stock-monitor.html', 'https://app.onewallie.com/'];
try {
  for (const url of urls) {
    const context = await browser.newContext();
    // Vercel filters webdriver/headless browsers. These are synthetic-test-only
    // overrides; DNT and GPC remain disabled so production transport is tested.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
      const native = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get.call(navigator);
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => native.replace('HeadlessChrome', 'Chrome') });
      Object.defineProperty(navigator, 'doNotTrack', { configurable: true, get: () => null });
      Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => false });
    });
    const page = await context.newPage();
    const post = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/_vercel/insights/view'), { timeout: 30000 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const response = await post;
    const body = response.request().postData() ?? '';
    assert([200, 202].includes(response.status()), `${url}: analytics response was ${response.status()}`);
    assert.equal(JSON.parse(body).o, url, 'pageview identifies the expected public page');
    assert(!/[?#]/.test(body), `${url}: analytics body contains a query or fragment: ${body}`);
    console.log(`PASS ${url} analytics POST ${response.status()} body=${body}`);
    await context.close();
  }
} finally {
  await browser.close();
}

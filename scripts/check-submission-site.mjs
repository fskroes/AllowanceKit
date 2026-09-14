/** Browser QA for the complete static submission artifact, including video playback. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [siteArg, playwrightArg, outputArg] = process.argv.slice(2);
if (!siteArg || !playwrightArg) {
  console.error('Usage: node scripts/check-submission-site.mjs SITE_DIR PLAYWRIGHT_MODULE [REPORT_DIR]');
  process.exit(2);
}
const site = path.resolve(siteArg);
const output = path.resolve(outputArg ?? '/tmp/wallie-site-qa');
fs.mkdirSync(output, { recursive: true });
const { chromium } = await import(pathToFileURL(path.resolve(playwrightArg)).href);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4', '.vtt': 'text/vtt', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/solana') { res.writeHead(308, { Location: '/solana.html' }); res.end(); return; }
  const file = path.resolve(site, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const size = fs.statSync(file).size;
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const headers = { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
    if (start > end) { res.writeHead(416); res.end(); return; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.SUBMISSION_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const report = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(origin) && response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(origin + '/solana', { waitUntil: 'networkidle' });
    assert.equal(new URL(page.url()).pathname, '/solana.html');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('h1').count(), 1);
    assert(await page.locator('h1').innerText().then(text => text.includes('An allowance')));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'horizontal page overflow');
    await page.screenshot({ path: path.join(output, `solana-${viewport.width}.png`), fullPage: true });
    await page.locator('a.button[href="#videos"]').first().click();
    for (const [index, expected] of [180, 300].entries()) {
      const video = page.locator('video').nth(index);
      await video.scrollIntoViewIfNeeded();
      await video.evaluate(element => { element.muted = true; element.load(); });
      await page.waitForFunction(({ index }) => Number.isFinite(document.querySelectorAll('video')[index].duration), { index });
      assert(Math.abs(await video.evaluate(element => element.duration) - expected) < 0.1);
      assert.equal(await video.locator('track[kind="captions"]').count(), 1);
      await video.evaluate(async element => { element.textTracks[0].mode = 'hidden'; await element.play(); });
      await page.waitForFunction(({ index }) => document.querySelectorAll('video')[index].currentTime > 0.1, { index });
      await video.evaluate(element => { element.pause(); element.currentTime = element.duration / 2; });
      await page.waitForFunction(({ index }) => !document.querySelectorAll('video')[index].seeking, { index });
      assert.equal(await video.evaluate(element => element.error), null);
      await video.screenshot({ path: path.join(output, `video-${index}-${viewport.width}.png`) });
    }
    for (const details of await page.locator('details').all()) {
      await details.locator('summary').click();
      assert.equal(await details.getAttribute('open'), '');
      await details.locator('summary').click();
    }
    // Verify the fallback without writing to the user's clipboard.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('permission denied'); } } }));
    await page.locator('[data-copy]').click();
    assert.match(await page.locator('[role="status"]').innerText(), /copy them manually/);
    assert.deepEqual(failures, []);
    report.push({ viewport, videoDurations: [180, 300], overflow: false, pageErrors: failures, checks: ['redirect', 'heading', 'video playback and seeking', 'captions', 'FAQ', 'clipboard fallback'] });
    await context.close();
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

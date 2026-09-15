/** Read-only Vercel routing checks. Authentication stays inside the Vercel CLI. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [siteDir, cloudDir, siteUrl, cloudUrl, reportFile] = process.argv.slice(2);
if (!siteDir || !cloudDir || !siteUrl || !cloudUrl) {
  console.error('Usage: node scripts/check-deployed-sites.mjs SITE_DIR CLOUD_DIR SITE_URL CLOUD_URL [REPORT_JSON]');
  process.exit(2);
}
for (const url of [siteUrl, cloudUrl]) assert.equal(new URL(url).protocol, 'https:');
const scratch = await mkdtemp(path.join(tmpdir(), 'wallie-deployment-check-'));
const cases = [];
function check(project, pathname, status, inspect = () => {}) {
  cases.push({ project, pathname, status, inspect });
}
const html = noindex => body => {
  assert.match(body, /<title>[^<]+<\/title>/i, 'Page title');
  assert.match(body, /<meta[^>]+name="description"[^>]+content="[^"]+"/i, 'Description');
  assert.match(body, /<link[^>]+rel="icon"/i, 'Favicon');
  if (noindex) assert.match(body, /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i);
};
for (const pathname of ['/', '/cloud.html', '/docs.html', '/x402-spending-limits.html', '/privacy.html', '/terms.html', '/solana']) {
  check('site', pathname, 200, body => {
    html(false)(body);
    if (['/privacy.html', '/terms.html'].includes(pathname)) assert.match(body, /Eames, Biesbosch 273, 1181 JC, Amstelveen, The Netherlands\./);
  });
}
for (const pathname of ['/stock-monitor.html', '/stock-monitor']) check('site', pathname, 200, body => {
  html(false)(body);
  assert.match(body, /npm run demo:stocks/);
  assert.match(body, /AAPLx/);
  assert.match(body, /simulated USDC/);
});
check('site', '/solana.html', 200, body => {
  html(false)(body);
  assert.match(body, /Run the offline demo/);
  assert(!/<video\b/i.test(body.replace(/<template\b[\s\S]*?<\/template>/gi, '')), 'Deferred videos must stay inert');
});
check('site', '/sitemap.xml', 200, body => {
  assert.match(body, /\/solana(?:\.html)?<\/loc>/);
  assert.match(body, /\/stock-monitor\.html<\/loc>/);
  assert(!body.includes('/404'), '404 must not be indexed');
});
check('site', '/robots.txt', 200, body => assert.match(body, /Sitemap:/i));
check('site', '/assets/generated/dashboard-480.webp', 200, (_body, raw) => assert.equal(raw.subarray(8, 12).toString('ascii'), 'WEBP'));
check('site', '/api/waitlist', 405, body => assert.equal(JSON.parse(body).ok, false));
// Vercel also routes .js aliases to the functions. Verify JSON execution, not a
// source-file response; MRR depends on optional Stripe configuration in previews.
check('site', '/api/waitlist.js', 405, body => assert.equal(JSON.parse(body).ok, false));
for (const pathname of ['/api/stock-monitor', '/api/stock-monitor.js']) check('site', pathname, 405, body => assert.match(JSON.parse(body).error, /Use POST/));
check('site', '/assets/stock-monitor.mjs', 200, body => assert.match(body, /\/api\/stock-monitor/));
check('site', '/assets/stock-monitor.css', 200, body => assert.match(body, /\.stock-page/));
check('site', '/api/mrr.js', [200, 502, 503], body => assert.equal(typeof JSON.parse(body), 'object'));
for (const pathname of ['/scripts/build-assets.mjs', '/scripts/indexnow-config.json', '/lib/stock-monitor/runtime.mjs', '/vercel.json', '/.env']) {
  check('site', pathname, 404);
}
for (const pathname of ['/', '/overview', '/key', '/events', '/alerts', '/billing', '/welcome']) {
  check('cloud', pathname, 200, html(true));
}
check('cloud', '/robots.txt', 200, body => assert.match(body, /Disallow: \/v1\//));
check('cloud', '/v1/account/overview', 401);
for (const pathname of ['/scripts/build-assets.mjs', '/lib/db.ts', '/vercel.json', '/.env']) check('cloud', pathname, 404);
for (const project of ['site', 'cloud']) {
  check(project, '/launch-check-missing-20260914', 404, body => {
    html(true)(body);
    assert.match(body, /<h1[^>]*>\s*Page not found/i);
  });
  check(project, '/assets/generated/analytics-client.mjs', 200, body => assert.match(body, /function inject\(/));
}

let next = 0;
const results = [];
async function worker() {
  while (next < cases.length) {
    const index = next++;
    const test = cases[index];
    const filename = path.join(scratch, String(index));
    const [cwd, deployment] = test.project === 'site' ? [siteDir, siteUrl] : [cloudDir, cloudUrl];
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn('vercel', ['curl', test.pathname, '--deployment', deployment, '--', '--silent', '--show-error', '--location', '--max-redirs', '3', '--max-time', '30', '--output', filename, '--write-out', '%{http_code}'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Vercel GET failed: ${test.project} ${test.pathname} (exit ${code})`)));
    });
    const actual = Number(stdout.match(/(\d{3})\s*$/)?.[1]);
    const expected = Array.isArray(test.status) ? test.status : [test.status];
    assert(expected.includes(actual), `${test.project} ${test.pathname}: HTTP ${actual}, expected ${expected.join('/')}`);
    const raw = await readFile(filename);
    test.inspect(raw.toString('utf8'), raw);
    results.push({ site: test.project, path: test.pathname, status: actual });
  }
}
try {
  const workers = await Promise.allSettled([worker(), worker(), worker()]);
  const failures = workers.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Deployed site checks failed');
  const report = { checkedAt: new Date().toISOString(), siteUrl, cloudUrl, requests: results.sort((a, b) => `${a.site}${a.path}`.localeCompare(`${b.site}${b.path}`)) };
  if (reportFile) await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(`PASS: ${results.length} deployed GET checks; pages, assets, 404s, discovery, API routing and source exclusions.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

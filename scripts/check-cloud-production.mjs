import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const [cloudDir] = process.argv.slice(2);
if (!cloudDir) throw new Error('Run through cloud-production.mjs CLOUD_DIR verify');
const load = file => import(pathToFileURL(path.join(path.resolve(cloudDir), 'lib', file)).href);
const { getDb } = await load('db.ts');
const { createMagicLink } = await load('magiclink.ts');
const { hashKey, keyPrefix } = await load('auth.ts');

const db = getDb();
const workspaceId = crypto.randomUUID();
const keyId = crypto.randomUUID();
const key = `wk_test_${crypto.randomBytes(24).toString('hex')}`;
const name = `__launch_smoke_${workspaceId}`;
let failure;
try {
  const link = await db.transaction(async tx => {
    const email = `${workspaceId}@example.invalid`;
    await tx.query('insert into workspaces(id,name,status,billing_email) values ($1,$2,$3,$4)', [workspaceId, name, 'active', email]);
    await tx.query('insert into workspace_keys(id,workspace_id,key_hash,prefix) values ($1,$2,$3,$4)', [keyId, workspaceId, hashKey(key), keyPrefix(key)]);
    const minted = await createMagicLink(tx, email);
    assert.ok(minted, 'synthetic magic link created');
    return minted;
  });
  await writeFile(path.join(tmpdir(), 'wallie-cloud-smoke-fixture.json'), JSON.stringify({ workspaceId, keyId, name }));
  const callback = await fetch(`https://app.onewallie.com/v1/auth/callback?token=${encodeURIComponent(link.token)}`, {
    signal: AbortSignal.timeout(30000), redirect: 'manual',
  });
  assert.equal(callback.status, 302, 'production sign-in callback');
  assert.equal(callback.headers.get('location'), 'https://app.onewallie.com/overview', 'production sign-in succeeded');
  const setCookie = callback.headers.get('set-cookie');
  assert.ok(setCookie?.startsWith('wc_session='), 'production callback sets a session');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  const cookie = setCookie.split(';')[0];
  for (const escrowedMicro of ['250000', '0']) {
    const heartbeat = await fetch('https://api.onewallie.com/v1/heartbeat', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: '__launch_smoke__', network: 'solana-devnet', mode: 'practice', version: 'launch-smoke', escrowedMicro }),
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    assert.equal(heartbeat.status, 200, 'authenticated production heartbeat');
    assert.equal((await heartbeat.json()).ok, true);
    const overview = await fetch('https://app.onewallie.com/v1/account/overview', {
      headers: { cookie }, signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    assert.equal(overview.status, 200, 'authenticated production overview');
    const body = await overview.json();
    assert.equal(body.workspace.name, name);
    assert.equal(body.escrowedMicro, escrowedMicro);
    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0].escrowedMicro, escrowedMicro);
    assert.equal(body.agents[0].silent, false);
    assert.ok(Date.now() - Date.parse(body.agents[0].lastSeenAt) < 60000);
  }
} catch (error) { failure = error; }
finally {
  try {
    await db.transaction(async tx => {
      await tx.query('delete from rate_limits where key_id = $1', [keyId]);
      await tx.query('delete from workspaces where id = $1 and name = $2', [workspaceId, name]);
    });
    const remaining = await db.query('select id from workspaces where id = $1', [workspaceId]);
    assert.equal(remaining.rows.length, 0, 'synthetic workspace removed');
  } catch (error) { failure = new Error(`Cleanup failed for synthetic workspace ${workspaceId}`, { cause: error }); }
}
if (failure) { console.error(failure); process.exit(1); }
await writeFile(path.join(tmpdir(), 'wallie-cloud-smoke.json'), JSON.stringify({ checkedAt: new Date().toISOString(), signInCallback: true, heartbeats: 2, overviews: 2, escrowValues: ['250000', '0'], fixtureRemoved: true, emailsSent: 0 }, null, 2));
console.log('PASS: 2 authenticated production heartbeats and 2 overviews; escrow set and cleared; fixture removed; no email sent.');
process.exit(0);

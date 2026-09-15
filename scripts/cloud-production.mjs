/** Run a Cloud database command with only the linked production DATABASE_URL. */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [cloudDir, action] = process.argv.slice(2);
if (!cloudDir || !['check:schema', 'migrate', 'verify'].includes(action)) {
  console.error('Usage: node scripts/cloud-production.mjs CLOUD_DIR check:schema|migrate|verify');
  process.exit(2);
}
const project = path.resolve(cloudDir);
const scratch = await mkdtemp(path.join(tmpdir(), 'wallie-production-'));
try {
  await mkdir(path.join(scratch, '.vercel'));
  let link;
  try { link = JSON.parse(await readFile(path.join(project, '.vercel/project.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const repo = JSON.parse(await readFile(path.join(project, '.vercel/repo.json'), 'utf8'));
    const projects = Object.values(repo.projects ?? {});
    if (projects.length !== 1) throw new Error('Expected exactly one linked Cloud project');
    link = { projectId: projects[0].id, orgId: projects[0].orgId };
  }
  if (!link.projectId || !link.orgId) throw new Error('Invalid Vercel project link');
  await writeFile(path.join(scratch, '.vercel/project.json'), JSON.stringify(link));
  // Vercel CLI merges local dotenv and parent variables over downloaded values.
  // A clean cwd excludes dotenv; clearing DATABASE_URL excludes a shell override.
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const command = action === 'verify'
    ? [fileURLToPath(new URL('./check-cloud-production.mjs', import.meta.url)), project]
    : [path.join(project, 'scripts', action === 'migrate' ? 'migrate.ts' : 'check-schema.ts')];
  const code = await new Promise((resolve, reject) => {
    const child = spawn('vercel', ['env', 'run', '-e', 'production', '--', process.execPath, ...command], {
      cwd: scratch, env, stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(scratch, { recursive: true, force: true });
}

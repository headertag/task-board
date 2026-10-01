import { appendFileSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readProductionEnvironment, writeProductionConfig, workerName } from './production-config.mjs';
import { smokeProduction } from './production-smoke.mjs';
import { authorizationServerMetadata } from '../lib/oauth-metadata.ts';

function schemaStatements(sql) {
  const statements = [];
  let statement = '';
  for (let offset = 0; offset < sql.length;) {
    const character = sql[offset], following = sql[offset + 1];
    if (character === '-' && following === '-') {
      statement += ' ';
      const end = sql.indexOf('\n', offset + 2);
      offset = end < 0 ? sql.length : end + 1;
    } else if (character === '/' && following === '*') {
      const end = sql.indexOf('*/', offset + 2);
      if (end < 0 || sql.slice(offset + 2, end).includes('/*')) throw new Error('Unsupported or unterminated SQL comment');
      statement += ' ';
      offset = end + 2;
    } else if (["'", '"', '`', '['].includes(character)) {
      const closing = character === '[' ? ']' : character;
      let end = offset + 1, closed = false;
      while (end < sql.length) {
        if (sql[end] !== closing) { end++; continue; }
        if (character !== '[' && sql[end + 1] === closing) { end += 2; continue; }
        closed = true;
        break;
      }
      if (!closed) throw new Error('Unterminated SQL string or quoted identifier');
      // Keep token boundaries while preventing literal/comment contents and
      // quoted identifier names from being interpreted as SQL operations.
      statement += character === "'" ? " '' " : ' __quoted_identifier__ ';
      offset = end + 1;
    } else if (character === ';') {
      if (statement.trim()) statements.push(statement.trim());
      statement = '';
      offset++;
    } else {
      statement += character;
      offset++;
    }
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

export function validateSchemaMigrations(root) {
  const files = readdirSync(path.join(root, 'drizzle')).filter(name => name.toLowerCase().endsWith('.sql')).sort();
  if (!files.length) throw new Error('Schema migration files are missing');
  for (const file of files) {
    const stat = lstatSync(path.join(root, 'drizzle', file));
    if (!/^\d+_[a-zA-Z0-9_]+\.sql$/.test(file) || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsupported schema migration filename or file type');
    const sql = readFileSync(path.join(root, 'drizzle', file), 'utf8');
    for (const statement of schemaStatements(sql)) {
      // Automatic deployment accepts additive schema only. Data transfer is separate.
      const createTable = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s*\(/i.test(statement);
      const createIndex = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+\w+\s*\(/i.test(statement);
      const addColumn = /^ALTER\s+TABLE\s+\w+\s+ADD\s+(?:COLUMN\s+)?\w+\b/i.test(statement);
      if (!createTable && !createIndex && !addColumn) throw new Error(`Migration ${file} is not additive schema-only; review data/destructive changes separately`);
    }
  }
  return files;
}

export async function command(executable, args, { root, env, capture = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
    let stdout = '';
    if (capture) { child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume(); }
    child.on('error', () => reject(new Error(`Could not run ${path.basename(executable)}`)));
    child.on('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${path.basename(executable)} command failed (${code})`)));
  });
}
export async function currentMain(settings, { root, env, run = command }) {
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Production deployment requires a checked push to main');
  const head = await run('git', ['rev-parse', 'HEAD'], { root, env, capture: true });
  if (head !== settings.sha) throw new Error('Checkout does not match the checked commit');
  await run('git', ['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main'], { root, env, capture: true });
  const main = await run('git', ['rev-parse', 'refs/remotes/origin/main'], { root, env, capture: true });
  if (!/^[a-f0-9]{40}$/.test(main)) throw new Error('Could not verify the current main commit');
  return main === settings.sha;
}
export async function verifyProductionResources(settings, env, request = fetch) {
  async function resource(route) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/${route}`;
    const response = await request(url, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (!response.ok || response.redirected || (response.url && response.url !== url)) throw new Error('Production Cloudflare resource preflight failed');
    const data = await response.json();
    if (data.success !== true || !data.result) throw new Error('Production Cloudflare resource preflight failed');
    return data.result;
  }
  const database = await resource(`d1/database/${settings.databaseId}`);
  if (database.uuid !== settings.databaseId || database.name !== settings.databaseName) throw new Error('Production D1 identity does not match the approved binding');
  const bucket = await resource(`r2/buckets/${settings.bucketName}`);
  if (bucket.name !== settings.bucketName) throw new Error('Production R2 identity does not match the approved binding');
  const managedDomain = await resource(`r2/buckets/${settings.bucketName}/domains/managed`);
  const customDomains = await resource(`r2/buckets/${settings.bucketName}/domains/custom`);
  if (managedDomain.enabled !== false || !Array.isArray(customDomains.domains) || customDomains.domains.some(domain => domain.enabled !== false)) throw new Error('Production R2 must have all public bucket domains disabled');
  const subdomain = await resource('workers/subdomain');
  if (settings.origin !== `https://${workerName}.${subdomain.subdomain}.workers.dev`) throw new Error('Production endpoint does not match this account workers.dev subdomain');
  await authorizationServerMetadata(settings.auth, request);
}

export async function deployProduction({ env = process.env, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), run = command, request = fetch, smoke = smokeProduction } = {}) {
  const settings = readProductionEnvironment(env);
  const files = validateSchemaMigrations(root);
  if (!await currentMain(settings, { root, env, run })) return { skipped: true, reason: 'A newer main commit supersedes this checked build', sha: settings.sha };
  await verifyProductionResources(settings, env, request);
  const { configPath, secretsPath } = writeProductionConfig(settings, root);
  const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
  try {
    // Recheck after preflight, before the first remote write.
    if (!await currentMain(settings, { root, env, run })) return { skipped: true, reason: 'A newer main commit supersedes this checked build', sha: settings.sha };
    await run(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath], { root, env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
    // Additive schema may safely remain if main changed while migrations ran.
    if (!await currentMain(settings, { root, env, run })) return { skipped: true, reason: 'Main changed during schema migration; no stale Worker was deployed', sha: settings.sha };
    await run(process.execPath, [wrangler, 'deploy', '--config', configPath, '--secrets-file', secretsPath, '--tag', settings.sha, '--message', `Checked main ${settings.sha}`], { root, env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
    const result = await smoke(settings, request);
    return { ...result, worker: workerName, sha: settings.sha, readOnly: settings.readOnly, schemaMigrations: files, dataImport: false };
  } finally { rmSync(secretsPath, { force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await deployProduction();
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.skipped ? `Production deployment skipped: ${result.reason}.\n` : `Production: ${result.origin}\n\nMCP: ${result.mcp}\n\nCommit: ${result.sha}\n\nRead-only: ${result.readOnly}. Applied pending additive schema only; no task data was imported or reset.\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

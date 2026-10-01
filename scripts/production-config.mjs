import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAuthConfig } from '../lib/auth.ts';
import { readBrowserConfig } from '../lib/browser-auth.ts';

export const workerName = 'task-board';
export const workerSecretNames = ['WORKOS_API_KEY', 'TASK_BOARD_SESSION_SECRET', 'TASK_BOARD_AUTH_POLICY'];
const placeholder = /(?:^|[.\/_-])(?:staging|stage|test|demo|example|placeholder|replace|local)(?:$|[.\/_-])/i;
function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Missing or invalid ${name}`);
  return value;
}
function flag(env, name) {
  const value = env[name] || 'false';
  if (!['true', 'false'].includes(value)) throw new Error(`Invalid ${name}: use true or false`);
  return value === 'true';
}

/** No staging fallback, resource creation, implicit write activation, or secret logging. */
export function readProductionEnvironment(env) {
  const accountId = required(env, 'CLOUDFLARE_ACCOUNT_ID');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('Invalid CLOUDFLARE_ACCOUNT_ID');
  required(env, 'CLOUDFLARE_API_TOKEN');
  const databaseId = required(env, 'TASK_BOARD_D1_DATABASE_ID');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(databaseId) || databaseId === '00000000-0000-4000-8000-000000000000') throw new Error('Invalid TASK_BOARD_D1_DATABASE_ID');
  const databaseName = required(env, 'TASK_BOARD_D1_DATABASE_NAME');
  const bucketName = required(env, 'TASK_BOARD_R2_BUCKET_NAME');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(databaseName) || placeholder.test(databaseName)) throw new Error('Invalid TASK_BOARD_D1_DATABASE_NAME');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName) || placeholder.test(bucketName)) throw new Error('Invalid TASK_BOARD_R2_BUCKET_NAME');
  const origin = required(env, 'TASK_BOARD_PRODUCTION_ORIGIN');
  let url;
  try { url = new URL(origin); } catch { throw new Error('Invalid TASK_BOARD_PRODUCTION_ORIGIN'); }
  if (url.origin !== origin || url.protocol !== 'https:' || !/^task-board\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) || url.username || url.password) throw new Error('TASK_BOARD_PRODUCTION_ORIGIN must be the stable task-board workers.dev origin');
  if (required(env, 'TASK_BOARD_WORKOS_ENVIRONMENT') !== 'production') throw new Error('TASK_BOARD_WORKOS_ENVIRONMENT must explicitly select production');
  const issuer = required(env, 'WORKOS_AUTHKIT_ISSUER');
  if (placeholder.test(issuer)) throw new Error('WORKOS_AUTHKIT_ISSUER must identify the approved production environment');
  const apiKey = required(env, 'WORKOS_API_KEY');
  if (!apiKey.startsWith('sk_') || apiKey.startsWith('sk_test_') || placeholder.test(apiKey)) throw new Error('WORKOS_API_KEY must be the approved production key');
  const sessionSecret = required(env, 'TASK_BOARD_SESSION_SECRET');
  const policy = required(env, 'TASK_BOARD_AUTH_POLICY');
  const browserClientId = required(env, 'WORKOS_BROWSER_CLIENT_ID');
  const audience = origin + '/mcp';
  let auth;
  try {
    auth = readAuthConfig({ WORKOS_AUTHKIT_ISSUER: issuer, WORKOS_MCP_AUDIENCE: audience, WORKOS_API_KEY: apiKey, TASK_BOARD_AUTH_POLICY: policy });
    readBrowserConfig({ TASK_BOARD_ORIGIN: origin, WORKOS_BROWSER_CLIENT_ID: browserClientId, TASK_BOARD_SESSION_SECRET: sessionSecret }, auth);
  } catch { throw new Error('Invalid production WorkOS, browser, session, or authorization policy configuration'); }
  if (!auth.policy.owners.length || auth.policy.owners.some(owner => owner.identities.some(identity => !identity.providerId || !identity.workosUserId))) throw new Error('Production policy must explicitly pin owner provider IDs and WorkOS user IDs');
  const migrationApproved = flag(env, 'TASK_BOARD_INITIAL_MIGRATION_APPROVED');
  const writesEnabled = flag(env, 'TASK_BOARD_ENABLE_WRITES');
  if (writesEnabled && !migrationApproved) throw new Error('Writes require TASK_BOARD_INITIAL_MIGRATION_APPROVED after verified initial migration and acceptance');
  const sha = required(env, 'GITHUB_SHA');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid GITHUB_SHA');
  return {
    accountId, databaseId, databaseName, bucketName, origin, audience, issuer, sha,
    readOnly: !writesEnabled,
    vars: { WORKOS_AUTHKIT_ISSUER: issuer, WORKOS_MCP_AUDIENCE: audience, TASK_BOARD_ORIGIN: origin, WORKOS_BROWSER_CLIENT_ID: browserClientId, TASK_BOARD_READ_ONLY: writesEnabled ? 'false' : 'true', TASK_BOARD_DEPLOYED_SHA: sha },
    secrets: { WORKOS_API_KEY: apiKey, TASK_BOARD_SESSION_SECRET: sessionSecret, TASK_BOARD_AUTH_POLICY: policy },
    auth,
  };
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Production configuration directory must be private');
}
function privateJSON(filename, value) {
  if (existsSync(filename) && (lstatSync(filename).isSymbolicLink() || !lstatSync(filename).isFile() || (lstatSync(filename).mode & 0o077))) throw new Error('Production configuration file must be private');
  writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export function writeProductionConfig(settings, root) {
  const built = JSON.parse(readFileSync(path.join(root, 'dist/server/wrangler.json'), 'utf8'));
  if (built.main !== 'index.js' || !built.no_bundle || !Array.isArray(built.compatibility_flags) || !built.compatibility_flags.includes('nodejs_compat') || !/^\d{4}-\d{2}-\d{2}$/.test(built.compatibility_date)) throw new Error('Unsupported checked build configuration');
  if (!existsSync(path.join(root, 'dist/server/index.js')) || !existsSync(path.join(root, 'dist/client'))) throw new Error('The checked Worker build is missing');
  const directory = path.join(root, '.wrangler/production');
  privateDirectory(directory);
  const configPath = path.join(directory, 'wrangler.json');
  const secretsPath = path.join(directory, 'secrets.json');
  const config = {
    name: workerName, account_id: settings.accountId, main: path.join(root, 'dist/server/index.js'),
    compatibility_date: built.compatibility_date, compatibility_flags: built.compatibility_flags,
    no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
    workers_dev: true, preview_urls: false,
    assets: { directory: path.join(root, 'dist/client') },
    d1_databases: [{ binding: 'DB', database_name: settings.databaseName, database_id: settings.databaseId, migrations_dir: path.join(root, 'drizzle') }],
    r2_buckets: [{ binding: 'IMAGES', bucket_name: settings.bucketName }],
    vars: settings.vars,
    observability: { enabled: false },
  };
  privateJSON(configPath, config);
  privateJSON(secretsPath, settings.secrets);
  return { configPath, secretsPath, config };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const settings = readProductionEnvironment(process.env);
    writeProductionConfig(settings, root);
    console.log(JSON.stringify({ worker: workerName, origin: settings.origin, mcp: settings.audience, readOnly: settings.readOnly, sha: settings.sha }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

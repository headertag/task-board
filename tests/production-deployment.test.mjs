import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProductionEnvironment, writeProductionConfig } from '../scripts/production-config.mjs';
import { currentMain, deployProduction, validateSchemaMigrations, verifyProductionResources } from '../scripts/production-deploy.mjs';
import { smokeProduction } from '../scripts/production-smoke.mjs';

const sha = '1'.repeat(40), newer = '2'.repeat(40);
const issuer = 'https://owner-prod.authkit.app';
function environment(overrides = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'fictional-cloudflare-access',
    TASK_BOARD_D1_DATABASE_ID: '11111111-2222-4333-8444-555555555555', TASK_BOARD_D1_DATABASE_NAME: 'task-board', TASK_BOARD_R2_BUCKET_NAME: 'task-board-images',
    TASK_BOARD_PRODUCTION_ORIGIN: 'https://task-board.fictional-owner.workers.dev', TASK_BOARD_WORKOS_ENVIRONMENT: 'production',
    WORKOS_AUTHKIT_ISSUER: issuer, WORKOS_BROWSER_CLIENT_ID: 'client_fictional', WORKOS_API_KEY: 'sk_live_fictional123456',
    TASK_BOARD_SESSION_SECRET: 'A'.repeat(43), TASK_BOARD_AUTH_POLICY: JSON.stringify({ version: 1, owners: [{ ownerId: 'fictional-storage-owner', identities: [{ provider: 'google', providerId: 'fictional-provider-id', workosUserId: 'user_fictional', email: 'owner@fictional.invalid' }] }], clients: [] }),
    GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', ...overrides,
  };
}
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-board-deploy-'));
  mkdirSync(path.join(root, 'dist/server'), { recursive: true });
  mkdirSync(path.join(root, 'dist/client'), { recursive: true });
  mkdirSync(path.join(root, 'drizzle'));
  writeFileSync(path.join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', compatibility_date: '2026-05-15', compatibility_flags: ['nodejs_compat'], no_bundle: true }));
  writeFileSync(path.join(root, 'dist/server/index.js'), 'export default {};');
  writeFileSync(path.join(root, 'drizzle/0000_schema.sql'), 'CREATE TABLE tasks (id TEXT PRIMARY KEY, payload TEXT); CREATE INDEX task_id ON tasks (id);');
  return root;
}
function metadata() {
  return { issuer, authorization_endpoint: issuer + '/oauth2/authorize', token_endpoint: issuer + '/oauth2/token', jwks_uri: issuer + '/oauth2/jwks', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] };
}
function preflightRequest(overrides = {}) {
  return async (url, options) => {
    const href = String(url);
    assert.equal(options.redirect, 'manual');
    if (href.startsWith(issuer + '/')) { assert.equal(options.headers.Authorization, undefined); return Response.json(metadata()); }
    assert.equal(new URL(href).origin, 'https://api.cloudflare.com');
    assert.equal(options.headers.Authorization, 'Bearer fictional-cloudflare-access');
    let result;
    if (href.endsWith('/domains/managed')) result = { enabled: false };
    else if (href.endsWith('/domains/custom')) result = { domains: [] };
    else if (href.endsWith('/workers/subdomain')) result = { subdomain: 'fictional-owner' };
    else if (href.includes('/d1/database/')) result = { uuid: environment().TASK_BOARD_D1_DATABASE_ID, name: 'task-board' };
    else if (href.includes('/r2/buckets/')) result = { name: 'task-board-images' };
    else throw new Error('Unexpected preflight URL');
    for (const [suffix, replacement] of Object.entries(overrides)) if (href.endsWith(suffix)) result = replacement;
    return Response.json({ success: true, result });
  };
}
function recorder(mainHeads = [sha, sha, sha], failure) {
  const calls = [], pending = [...mainHeads];
  const run = async (executable, args) => {
    calls.push({ executable, args });
    if (args.join(' ') === 'rev-parse HEAD') return sha;
    if (args.join(' ') === 'rev-parse refs/remotes/origin/main') return pending.shift() ?? mainHeads.at(-1);
    if (failure && args.includes(failure)) throw new Error('Fictional remote command failure');
    return '';
  };
  return { calls, run };
}

test('production configuration requires explicit resources, secrets, production identity, and immutable owner bindings', () => {
  const expected = environment();
  for (const name of Object.keys(expected).filter(name => !['GITHUB_EVENT_NAME', 'GITHUB_REF'].includes(name))) {
    assert.throws(() => readProductionEnvironment({ ...expected, [name]: '' }), undefined, name);
  }
  for (const overrides of [
    { TASK_BOARD_WORKOS_ENVIRONMENT: 'staging' }, { WORKOS_AUTHKIT_ISSUER: 'https://owner-staging.authkit.app' }, { WORKOS_API_KEY: 'sk_test_fictional' },
    { TASK_BOARD_PRODUCTION_ORIGIN: 'https://task-board-oauth-staging.fictional-owner.workers.dev' },
    { TASK_BOARD_D1_DATABASE_ID: '00000000-0000-4000-8000-000000000000' },
    { TASK_BOARD_AUTH_POLICY: '{"version":1,"owners":[],"clients":[]}' },
    { TASK_BOARD_SESSION_SECRET: 'invalid' }, { TASK_BOARD_ENABLE_WRITES: 'yes' },
    { TASK_BOARD_AUTH_POLICY: JSON.stringify({ version: 1, owners: [{ ownerId: 'fictional', identities: [{ provider: 'google', email: 'owner@fictional.invalid' }] }], clients: [] }) },
  ]) assert.throws(() => readProductionEnvironment(environment(overrides)));
});

test('writes stay frozen until the separately approved initial migration is explicitly activated', () => {
  assert.equal(readProductionEnvironment(environment()).readOnly, true);
  assert.equal(readProductionEnvironment(environment({ TASK_BOARD_INITIAL_MIGRATION_APPROVED: 'true' })).readOnly, true);
  assert.throws(() => readProductionEnvironment(environment({ TASK_BOARD_ENABLE_WRITES: 'true' })), /INITIAL_MIGRATION_APPROVED/);
  assert.equal(readProductionEnvironment(environment({ TASK_BOARD_INITIAL_MIGRATION_APPROVED: 'true', TASK_BOARD_ENABLE_WRITES: 'true' })).readOnly, false);
});

test('generated configuration binds only existing production resources and keeps secrets separate/private', () => {
  const root = fixture();
  try {
    const settings = readProductionEnvironment(environment());
    const result = writeProductionConfig(settings, root);
    assert.equal(result.config.name, 'task-board');
    assert.equal(result.config.vars.WORKOS_MCP_AUDIENCE, settings.origin + '/mcp');
    assert.equal(result.config.vars.TASK_BOARD_READ_ONLY, 'true');
    assert.equal(result.config.d1_databases[0].database_id, settings.databaseId);
    assert.equal(result.config.r2_buckets[0].bucket_name, settings.bucketName);
    assert.equal(result.config.d1_databases[0].migrations_dir, path.join(root, 'drizzle'));
    assert.equal(statSync(result.secretsPath).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(result.secretsPath)).mode & 0o777, 0o700);
    for (const value of Object.values(settings.secrets)) assert.equal(readFileSync(result.configPath, 'utf8').includes(value), false);
    assert.deepEqual(JSON.parse(readFileSync(result.secretsPath, 'utf8')), settings.secrets);
  } finally { rmSync(root, { recursive: true }); }
});

test('automatic migrations accept additive schema and reject data changes, resets, triggers, and table copies', () => {
  const root = fixture();
  try {
    assert.deepEqual(validateSchemaMigrations(root), ['0000_schema.sql']);
    const migration = path.join(root, 'drizzle/0001_change.sql');
    for (const sql of ['DROP TABLE tasks;', 'DELETE FROM tasks;', "INSERT INTO tasks VALUES ('a','b');", 'UPDATE tasks SET payload=NULL;', 'CREATE TABLE replacement AS SELECT * FROM tasks;', 'CREATE TRIGGER clear_tasks AFTER INSERT ON tasks BEGIN DELETE FROM tasks; END;']) {
      writeFileSync(migration, sql);
      assert.throws(() => validateSchemaMigrations(root), /not additive schema-only/);
    }
    writeFileSync(migration, '-- no record writes\nALTER TABLE tasks ADD COLUMN revision INTEGER;');
    assert.deepEqual(validateSchemaMigrations(root), ['0000_schema.sql', '0001_change.sql']);
  } finally { rmSync(root, { recursive: true }); }
});

test('schema guard handles SQL quoting/comments without hiding later record writes', () => {
  const root = fixture();
  const migration = path.join(root, 'drizzle/0001_quoted.sql');
  try {
    for (const sql of [
      "CREATE TABLE quoted (label TEXT DEFAULT '--'); DELETE FROM tasks;",
      "CREATE TABLE quoted (label TEXT DEFAULT '/*'); DELETE FROM tasks; -- */",
      "CREATE TABLE quoted (label TEXT DEFAULT 'literal;with;semicolons'); UPDATE tasks SET payload=NULL;",
      'CREATE TABLE "quoted--identifier" (label TEXT); INSERT INTO tasks VALUES (\'a\',\'b\');',
      'CREATE TABLE quoted AS WITH source AS (SELECT * FROM tasks) SELECT * FROM source;',
      'CREATE TABLE quoted AS VALUES (1);',
    ]) {
      writeFileSync(migration, sql);
      assert.throws(() => validateSchemaMigrations(root), /not additive schema-only/);
    }
    writeFileSync(migration, `
      -- A real comment with ; and DELETE is ignored.
      CREATE TABLE "quoted--table" ("label;name" TEXT DEFAULT '--;/*literal*/it''s safe');
      /* A comment between operations. */
      CREATE INDEX \`quoted/*index*/\` ON "quoted--table" ("label;name");
      ALTER TABLE "quoted--table" ADD COLUMN [extra;label] TEXT DEFAULT 'a;b';
    `);
    assert.deepEqual(validateSchemaMigrations(root), ['0000_schema.sql', '0001_quoted.sql']);
    for (const sql of ["CREATE TABLE quoted (label TEXT DEFAULT 'unfinished);", 'CREATE TABLE "unfinished (label TEXT);', 'CREATE TABLE quoted (label TEXT); /* unfinished', '/* nested /* unsupported */ CREATE TABLE quoted (label TEXT);']) {
      writeFileSync(migration, sql);
      assert.throws(() => validateSchemaMigrations(root), /Unsupported|Unterminated|unterminated/);
    }
  } finally { rmSync(root, { recursive: true }); }
});

test('a PR, wrong checked SHA, or stale main cannot start a production mutation', async () => {
  const root = fixture();
  try {
    const settings = readProductionEnvironment(environment());
    await assert.rejects(currentMain(settings, { root, env: environment({ GITHUB_EVENT_NAME: 'pull_request' }), run: recorder().run }), /checked push/);
    await assert.rejects(currentMain(settings, { root, env: environment(), run: async () => newer }), /checked commit/);
    const recorded = recorder([newer]);
    const result = await deployProduction({ root, env: environment(), run: recorded.run, request: () => { throw new Error('Stale run must not access production'); } });
    assert.equal(result.skipped, true);
    assert.equal(recorded.calls.some(call => call.args.includes('migrations') || call.args.includes('deploy')), false);
  } finally { rmSync(root, { recursive: true }); }
});

test('preflight rejects a wrong database, bucket, public image bucket, or account endpoint before writes', async () => {
  const settings = readProductionEnvironment(environment());
  await verifyProductionResources(settings, environment(), preflightRequest());
  for (const overrides of [
    { [settings.databaseId]: { uuid: settings.databaseId, name: 'wrong-board' } },
    { '/task-board-images': { name: 'wrong-bucket' } },
    { '/domains/managed': { enabled: true } },
    { '/domains/custom': { domains: [{ enabled: true }] } },
    { '/workers/subdomain': { subdomain: 'another-owner' } },
  ]) await assert.rejects(verifyProductionResources(settings, environment(), preflightRequest(overrides)));
});

test('a newer commit during preflight or migrations skips stale deployment and always removes temporary secrets', async () => {
  for (const heads of [[sha, newer], [sha, sha, newer]]) {
    const root = fixture();
    try {
      const recorded = recorder(heads);
      const result = await deployProduction({ root, env: environment(), run: recorded.run, request: preflightRequest(), smoke: () => { throw new Error('Stale build cannot reach smoke checks'); } });
      assert.equal(result.skipped, true);
      assert.equal(recorded.calls.some(call => call.args.includes('deploy')), false);
      assert.equal(recorded.calls.some(call => call.args.includes('migrations')), heads.length === 3);
      assert.equal(existsSync(path.join(root, '.wrangler/production/secrets.json')), false);
    } finally { rmSync(root, { recursive: true }); }
  }
});

test('successful deployment applies tracked schema only, uses pinned Wrangler and checked build, and reports stable MCP endpoint', async () => {
  const root = fixture();
  try {
    const recorded = recorder();
    const result = await deployProduction({ root, env: environment(), run: recorded.run, request: preflightRequest(), smoke: async settings => ({ origin: settings.origin, mcp: settings.audience, smoke: 'passed' }) });
    const remote = recorded.calls.filter(call => call.executable !== 'git');
    assert.equal(remote.length, 2);
    assert.deepEqual(remote[0].args.slice(1, 6), ['d1', 'migrations', 'apply', 'DB', '--remote']);
    assert.equal(remote[0].args[0], path.join(root, 'node_modules/wrangler/bin/wrangler.js'));
    assert.equal(remote[1].args[1], 'deploy');
    assert.equal(remote[1].args.includes('--secrets-file'), true);
    assert.equal(remote[1].args[remote[1].args.indexOf('--tag') + 1], sha);
    assert.equal(result.mcp, 'https://task-board.fictional-owner.workers.dev/mcp');
    assert.equal(result.dataImport, false);
    assert.equal(result.readOnly, true);
    assert.equal(existsSync(path.join(root, '.wrangler/production/secrets.json')), false);
    assert.equal(remote.some(call => call.args.includes('execute') || call.args.includes('import') || call.args.includes('secret')), false);
  } finally { rmSync(root, { recursive: true }); }
});

test('failed schema migration prevents upload and removes the temporary secret file', async () => {
  const root = fixture();
  try {
    const recorded = recorder(undefined, 'migrations');
    await assert.rejects(deployProduction({ root, env: environment(), run: recorded.run, request: preflightRequest() }), /remote command failure/);
    assert.equal(recorded.calls.some(call => call.args.includes('deploy')), false);
    assert.equal(existsSync(path.join(root, '.wrangler/production/secrets.json')), false);
  } finally { rmSync(root, { recursive: true }); }
});

function smokeRequest(overrides = {}) {
  const settings = readProductionEnvironment(environment());
  return async (url, options) => {
    const route = new URL(url).pathname;
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers?.Authorization, undefined);
    if (overrides[route]) return overrides[route]();
    if (route === '/.well-known/oauth-protected-resource/mcp') return Response.json({ resource: settings.audience, authorization_servers: [issuer] });
    if (route === '/.well-known/oauth-authorization-server') return Response.json(metadata());
    if (route === '/') return new Response(null, { status: 307, headers: { Location: '/auth/signin?return_to=%2F' } });
    return Response.json({ error: { code: 'sign_in_required' } }, { status: 401, headers: { 'Cache-Control': 'private, no-store', 'WWW-Authenticate': `Bearer resource_metadata="${settings.origin}/.well-known/oauth-protected-resource/mcp"` } });
  };
}
test('credential-free deployment smoke verifies production discovery and anonymous MCP/API/image/browser denial', async () => {
  const settings = readProductionEnvironment(environment());
  assert.equal((await smokeProduction(settings, smokeRequest())).smoke, 'passed');
  for (const overrides of [
    { '/mcp': () => Response.json({ tasks: [] }) },
    { '/.well-known/oauth-protected-resource/mcp': () => Response.json({ resource: 'https://wrong.invalid/mcp', authorization_servers: [issuer] }) },
    { '/.well-known/oauth-authorization-server': () => Response.json({ ...metadata(), token_endpoint: 'https://wrong.invalid/token' }) },
    { '/': () => new Response(null, { status: 307, headers: { Location: 'https://wrong.invalid/signin' } }) },
  ]) await assert.rejects(smokeProduction(settings, smokeRequest(overrides)));
});

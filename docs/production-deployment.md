# Production deployment

The production Worker is named **`task-board`**. Its stable origin is `https://task-board.<approved-account-subdomain>.workers.dev`, and its MCP endpoint is that origin followed by **`/mcp`**. The account subdomain is read from Cloudflare and checked against the configured origin before deployment. The staging Worker and the existing private Site remain separate resources.

After initial setup, a push to `main` runs the full checks and deploys its checked build automatically. Pull requests and other branches run checks without production secrets. Production data stays in the explicitly configured existing D1 database and private R2 bucket; application releases do not create resources, import records, seed samples, or reset data. The separate [one-time Cloudflare migration procedure](cloudflare-migration.md) preserves full v3 captures and includes its private CLI configuration and hosted storage checks.

## What the pipeline does

The `Checks / test` job installs the lockfile with Node 24, runs setup, type checking, application/auth/backup tests, MCP metadata checks, deployment tests, and the production build. For `main` pushes it retains the complete `dist/` artifact, including generated asset exclusions and manifests, under the exact commit SHA for seven days. `Deploy production` requires that successful job, checks out the same SHA, downloads that same run's artifact, and uses the lockfile's Wrangler version rather than installing a moving latest release. Production secrets are injected only into the deployment script step; dependency installation and the check job receive no production secrets.

Deployment jobs share the `task-board-production` concurrency group, with `queue: max` and `cancel-in-progress: false`. A release already applying schema or deploying code is not canceled by a later push. GitHub queues waiting releases; since check completion can be out of order, the script compares the checked SHA with current `main` before preflight, immediately before remote schema changes, and again before Worker upload. A superseded commit is reported as skipped instead of deploying older code over a newer release. The newest passing `main` run deploys automatically; a failing latest commit must be fixed or reverted through a checked `main` commit.

The production preflight fails before remote mutation if required configuration or secrets are missing, if the checkout is not the checked `main` push, if the D1 name/ID or R2 bucket differs, if public R2 access is enabled, if the account's Workers subdomain differs, or if the configured OAuth server has invalid discovery/PKCE metadata. It requires an explicit production WorkOS environment selection and rejects known test keys and obvious staging/example values. An arbitrary AuthKit domain or `sk_` key does not independently prove its WorkOS environment; select and verify the real production environment in the WorkOS dashboard during initial acceptance.

Only pending, tracked, **additive schema migrations** are applied with `wrangler d1 migrations apply DB --remote`. The guard accepts `CREATE TABLE`, `CREATE INDEX`, and `ALTER TABLE ... ADD COLUMN`; it rejects record writes, table copies, triggers, and destructive changes. The guard is conservative rather than a general SQL parser. A migration containing unsupported SQL needs a separately reviewed migration procedure; do not weaken the guard to sneak a data import into routine deployment. D1 records applied migration filenames, so repeat deployments do not replay applied migrations. Migrations must remain compatible with the previously deployed app if Worker upload fails after schema application.

The Worker deploy uploads the three configured Worker secrets alongside the checked build with `--secrets-file`. Secret values stay in a mode-`0600` file under ignored `.wrangler/production`, and the deploy script removes that file even when migration or deployment fails. Wrangler applies those secrets additively and preserves other existing secrets. Keep the session secret stable across normal releases; rotating it deliberately invalidates browser sessions. The declared non-secret vars are authoritative on each deploy, so make their changes in the GitHub production environment rather than only in the Cloudflare dashboard.

After upload, credential-free smoke checks verify the exact resource and issuer, upstream PKCE discovery, anonymous denial for MCP/API/images, and the browser's sign-in redirect. They make no task writes or data imports. The job prints the production origin, `/mcp` endpoint, checked SHA, read-only state, schema filenames, and `dataImport: false`, and adds the endpoint to its GitHub job summary. A failed smoke check makes the deployment job fail; it does not silently roll back code or database state. Investigate and deploy a checked fix/revert. These checks do not replace fresh owner sign-in, external-client OAuth acceptance, or migration readback.

## One-time resources and GitHub environment

Use the already approved Cloudflare account. Select or create the separately approved production D1 database and private R2 bucket before enabling the workflow. Keep `r2.dev` public access and all public custom domains disabled on that bucket. This workflow only checks their identities and binds them; resource creation and migration are separate operations.

Create the GitHub environment **`production`**, restrict its deployment branches to `main`, and configure the following environment variables. Do not place real values in repository files.

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Approved account's 32-character ID |
| `TASK_BOARD_D1_DATABASE_ID` | Existing production D1 UUID; the zero placeholder is rejected |
| `TASK_BOARD_D1_DATABASE_NAME` | Exact existing production D1 name |
| `TASK_BOARD_R2_BUCKET_NAME` | Exact existing private production bucket name |
| `TASK_BOARD_PRODUCTION_ORIGIN` | `https://task-board.<account-subdomain>.workers.dev`, without a trailing slash |
| `TASK_BOARD_WORKOS_ENVIRONMENT` | Exactly `production` |
| `WORKOS_AUTHKIT_ISSUER` | Exact verified production issuer origin, without a trailing slash |
| `WORKOS_BROWSER_CLIENT_ID` | Approved production Public PKCE browser client |
| `TASK_BOARD_INITIAL_MIGRATION_APPROVED` | Initially `false`; set `true` only after the initial acceptance/migration decision below |
| `TASK_BOARD_ENABLE_WRITES` | Initially `false`; activation described below |

Configure these **environment secrets** separately:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Approved deployment identity for this account: Worker scripts deployment/secrets, D1 schema migration, and read access to the R2 bucket/domain configuration and account Workers subdomain |
| `WORKOS_API_KEY` | Production environment key for authoritative user and linked-identity lookup |
| `TASK_BOARD_SESSION_SECRET` | Stable, 32 random bytes encoded as 43 unpadded base64url characters |
| `TASK_BOARD_AUTH_POLICY` | Valid one-line JSON policy explicitly binding verified immutable Google/GitHub provider IDs and WorkOS user IDs to the authorized existing storage owner |

Keep this Cloudflare token scoped to the approved account with the narrowest permissions supported for these operations. Routine releases need no R2 object upload, object deletion, DNS changes, or account/bucket/database creation. Initial migration uses its separately authorized data-transfer credentials and procedure.

Configure the production WorkOS environment with owner-controlled Google/GitHub credentials, the exact `${TASK_BOARD_PRODUCTION_ORIGIN}/mcp` resource, the browser callback `${TASK_BOARD_PRODUCTION_ORIGIN}/auth/callback`, and the actual external client's approved callback/registration mode. Browser and external-client grants are separate. Do not promote staging issuer/client/user settings or use staging social-provider credentials for production. See [OAuth hosting](oauth-hosting.md) for identity/client setup and [cutover](oauth-cutover.md) for full acceptance and migration evidence.

This production installation uses Google-only sign-in. Configure owner-controlled Google OAuth and disable all other WorkOS authentication methods, including GitHub, email/password, passkeys, Magic Auth and SSO. Its private policy must bind the exact verified allowed email, immutable Google provider ID and WorkOS user ID to the original storage owner. A linked Google identity does not attest which method authenticated the current session, so the Dashboard restriction is required; see [WorkOS authentication methods](https://workos.com/docs/authkit/users-organizations). The repository retains generic GitHub support for separately configured installations.

Protect `main` with the required `Checks / test` check, require the repository's intended review policy, and disallow force pushes/deletion. Restrict who can alter production variables, secrets, environment rules, and workflow files. GitHub environment required reviewers, if configured, pause every deployment for review; remove that per-release requirement only when the owner has authorized automatic deployment. The initial migration activation flags are configured once and do not require approval on each routine release.

## Initial deployment and write activation

1. Configure the production environment with both activation flags `false`. Missing flags also default to `false`. Complete the production owner identity mapping; the policy rejects unpinned production identities and empty owner lists.
2. Merge the checked implementation to `main`. The first release applies the additive application schema and deploys the stable Worker read-only. The generator takes the existing resource IDs from GitHub variables and the exact `/mcp` audience from the production origin; it has no staging fallback.
3. Complete the actual hosted owner/browser/API/image and consented external-client OAuth acceptance with fictional data in the approved isolated fixture owner. Keep any fixture mutations explicitly scoped to that acceptance procedure. Do not enable routine production-owner writes to make a discovery check pass.
4. Follow the approved real-data transfer in [OAuth cutover](oauth-cutover.md): freeze/drain the source, capture the complete source and authoritative upload retry state, recover and verify a copy, apply the reviewed owner-scoped D1/R2 migration, and compare full destination records/history/images/retry behavior. Portable copy import is not an exact migration. Routine CI does none of this.
5. After actual acceptance and exact migration/readback pass, record the owner's cutover decision and set `TASK_BOARD_INITIAL_MIGRATION_APPROVED=true`. Set `TASK_BOARD_ENABLE_WRITES=true` when the destination is authorized to become the sole writer. Both flags are required to enable writes; setting only the migration flag leaves the Worker read-only. These flags record that initial decision and cannot themselves prove the gates passed.
6. Re-run all jobs of the latest successful `main` workflow after changing the flags, or merge the next checked commit. Re-running all jobs recreates the checked artifact, including after its retention period ends. No workflow-dispatch release bypass is supplied. Verify the authenticated browser and fresh consented external client against the migrated IDs. External clients remain read-only unless the private policy explicitly grants an approved registered client a custom write scope.

For an incident freeze, set `TASK_BOARD_ENABLE_WRITES=false` and re-run the current successful `main` workflow. Coordinate source/destination write boundaries and rollback with [OAuth cutover](oauth-cutover.md); do not route users back to an old writable snapshot after destination writes have begun. Normal deployment preserves D1/R2 records and Worker secrets, but it does not reconcile two writable databases or perform data rollback.

## Local verification and authorized operations

Run the focused tests without any real configuration or credentials:

```sh
node --import tsx --test tests/production-deployment.test.mjs
```

For an authorized initial manual operation, the config generator accepts the same private environment variables and a 40-character `GITHUB_SHA` identifying the checked build:

```sh
node --import tsx scripts/production-config.mjs
```

It prints only the Worker name, production origin, `/mcp` endpoint, read-only state, and SHA, and writes ignored `.wrangler/production/wrangler.json` and `.wrangler/production/secrets.json`. It performs no deployment or migration. Remove the generated secret file immediately after its authorized use. The automated `production-deploy.mjs` entry point requires an actual GitHub `push` to `main` and the matching checkout; it supplies no local release override.

The standalone public smoke command needs only the production origin and issuer, and no bearer credentials:

```sh
node scripts/production-smoke.mjs
```

Official references: [GitHub concurrency and queued deployments](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments), [Wrangler deploy flags and secret preservation](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy), [D1 migrations apply](https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-migrations-apply), [secrets uploaded alongside code](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code), and [WorkOS staging/production API keys](https://workos.com/docs/reference/api-authentication).

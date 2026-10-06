# Private Executor deployment

This fork tracks upstream Executor v2. The private product lives in
`apps/private-cloud/`; its authorization, runtime bindings and deployment code
stay separate from upstream packages. See [private requirements](PRIVATE.md).

The owner chose Cloudflare for application compute and Hyperdrive for PostgreSQL.
The product Worker serves the dashboard, API and MCP. A Durable Object coordinates
the single owner. R2 stores builds, Artifacts stores app source, and Worker Loader
runs authored apps. Hyperdrive connects to a separate managed PostgreSQL database.
Disable Hyperdrive query caching: sessions, permissions and reads after writes
must be current. [Cloudflare explains that its default cache does not invalidate
on writes](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

```text
executor.umgbhalla.com -> product Worker -> Hyperdrive -> PostgreSQL
                                      +-> R2, Artifacts, Worker Loader
```

The scoped Cloudflare token and stable product secrets are in mode-0600 files
under `~/.local/state/executor-private/`. Never commit or print them. The deploy
token currently lacks Hyperdrive read access. The deploy script reads the selected
configuration and refuses to deploy unless query caching is disabled. The product needs two
separate PostgreSQL databases and cache-disabled Hyperdrive configurations:
one disposable stage and one production database. Store their 32-character IDs
as `EXECUTOR_STAGE_HYPERDRIVE_ID` and
`EXECUTOR_PRODUCTION_HYPERDRIVE_ID` in `deploy.env`. Store the matching direct
schema-owner URLs as `EXECUTOR_STAGE_DATABASE_URL` and
`EXECUTOR_PRODUCTION_DATABASE_URL` in that same private file.

Each deploy runs the separate SQL migration against the direct database URL
before uploading any replacement Worker. The migration must finish first;
failure leaves the old Worker online. Review every new schema step for
compatibility with the currently deployed Worker.

Build shared apps, telemetry and the dashboard with the repo's pinned Bun 1.4.2.
Then run `bun run --cwd apps/private-cloud build` and
`bun run --cwd apps/private-cloud deploy --stage`. This creates separate stage
Workers and R2 storage. Run the named private auth E2E scenario against its
workers.dev HTTPS URL. Only after stage, migration and app checks pass, run
`bun run --cwd apps/private-cloud deploy --production`. Production attaches
`executor.umgbhalla.com`; DNS is not changed before that point.

Published app pages use one-label hostnames ending
`--executor.umgbhalla.com`, which fit the zone's Universal SSL certificate.
They still need a proxied wildcard DNS record and the scoped Worker route
`*--executor.umgbhalla.com/*`. Add that route only after the product passes the
stage app-page scenario. Do not route all `*.umgbhalla.com` traffic to Executor;
other names in this zone serve different products.

Current status: the first PGlite stage deployed, but its product Durable Object
exceeded the Worker memory limit. Hyperdrive code builds and passes repository
checks. No PostgreSQL origin or Hyperdrive configuration exists yet. No
production Worker or DNS record has been created. The stage E2E scenario has
not run. Cloudflare's [Hyperdrive guide](https://developers.cloudflare.com/hyperdrive/get-started/)
requires an existing PostgreSQL origin.

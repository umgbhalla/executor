# Private Executor v2 on our Cloudflare account

This fork is `umgbhalla/executor`. `main` and `v2` use upstream's exported v2
source. The old main is retained at `archive/main-before-v2-2026-10-03`.
`origin` is our fork; `upstream` is only the source repository for future updates.
It is not a production service dependency.

## What self-hosting means here

Use the private product in `apps/hosted/self-host`, not the SaaS product in
`apps/hosted/cloud`. The private product provides password login, first-admin
setup, organizations, API, dashboard, MCP, app execution and bundled telemetry.
It does not require Autumn, PlanetScale, Axiom, Context.dev, Google login,
GitHub login or an upstream Executor account.

Provider credentials are still needed for the integrations we choose to connect.
Builds download packages. The public app registry defaults to `https://v2.executor.sh`;
registry browsing/installing published apps is an optional upstream dependency.
Direct app authoring and deployment are separate paths. A strict no-upstream
runtime deployment must also replace or disable that registry client and check
its UI callers. Do not point `EXECUTOR_REGISTRY_URL` at an endpoint that does not
serve the registry contract.

## Current deployment status

The accepted single-owner, paired-passkey scope and current account checks are
recorded in [private deployment requirements](PRIVATE.md). On 2026-10-06 a scoped
deployment token was created and verified, and the private R2 bucket
`executor-private-builds` was created and read back. A live Worker allocated
PGlite's minimum WebAssembly memory, but database startup and persistence still
need a live test. No private service or DNS record has been created.

The source already supports self-hosting with one persistent Docker volume.
It does not yet provide a tested, private Cloudflare-only deployment.
Do not run `hosted:cloud:deploy` for this goal: that selects the SaaS stack.
There is no automatic Cloudflare deployment workflow in this fork.

The private container needs `/app/data` to survive restarts and upgrades.
It holds workerd's SQLite-backed Durable Object state, product data, app data,
Git repositories, builds, and generated signing/encryption keys.
Do not deploy this image to an ordinary Cloudflare Container with temporary disk
and call it durable.

Cloudflare documents that container disks are ephemeral. Container snapshots
save point-in-time state, are immutable, and expire after 30 days unless restored.
They are not a replacement for acknowledging each database write durably.
R2 FUSE mounts exist, but the object-storage mount must be proven safe for this
workload's SQLite, Git, atomic replacement, locking and sync behavior before use.
That compatibility has not been established here.

Sources checked on 2026-10-03:

- [Container lifecycle and temporary disks](https://developers.cloudflare.com/containers/concepts/architecture/)
- [Container snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)
- [R2 FUSE mounts](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)

## Cloudflare-only implementation path

Reuse the private product's auth and routes. Move persistent state to Cloudflare
services instead of retaining it on a container's disk. The existing Cloud SaaS
adapters provide useful building blocks without requiring SaaS billing.

```text
Browser / MCP client
        |
        v
Our Cloudflare Worker: private auth, dashboard, API, MCP
        |
        +--> Durable Objects: product database and serialized app state
        +--> R2: builds and binary files
        +--> Artifacts or a replacement repository adapter: app source
        +--> Dynamic Workers: isolated authored apps
```

This is a target design, not a deployed or validated implementation.

The private packaged server already runs PGlite inside a workerd Durable Object
with a custom filesystem adapter. That is a starting point for a Cloudflare
port, not proof of compatibility. Its database bundle, startup, memory and
storage limits must pass in the actual Cloudflare runtime.

Work required:

1. Compose the private passkey product on Cloudflare. Preserve its
   single-owner setup and authorization. Admit browser pairing with the
   operator's manual key.
2. Replace native host configuration, local file blobs, native Git and local
   workerd bindings. Reuse the existing Cloudflare R2, source and sandbox adapters
   where their contracts match.
3. Deploy the private database as durable Cloudflare storage. Test concurrent
   writes, restart recovery, migrations, backups and restore. Prove that completed
   writes survive a Worker replacement and a container crash if containers remain.
4. Serve the self-host dashboard assets. Configure our HTTPS origin and stable
   keys. App web pages need a separate base with wildcard DNS and certificates.
5. Remove or explicitly opt into the upstream registry. Keep upstream analytics
   disabled. Connect only the integrations we select.
6. Run private auth, API, MCP, app execution and restart-persistence scenarios
   against our deployed stage before sending real credentials or data to it.

Do not replace PGlite with D1 by changing only a binding: the product's SQL schema
and queries currently use PostgreSQL behavior. Likewise, removing billing from
Cloud SaaS does not give it the private product's password and setup flows.

## What we need from our account

| Item                                          | Purpose                                                      |
| --------------------------------------------- | ------------------------------------------------------------ |
| Cloudflare account ID and scoped deploy token | Create and update our resources                              |
| Workers Paid plan                             | Containers if used; verify feature access for chosen runtime |
| Our dashboard domain and DNS zone             | HTTPS, auth cookies, MCP discovery and callbacks             |
| Stable auth secret and 32-byte encryption key | Sessions and stored integration credentials                  |
| Optional app-domain base                      | Browser pages for authored apps                              |
| Backup destination and restore procedure      | Recover private state and keys                               |

Cloudflare service access, storage/runtime limits and pricing must be checked for
our chosen design before deployment. The account used by `abdw` and the proposed
dashboard origin `https://executor.umgbhalla.com` have now been selected. See
[the current preparation receipt](PRIVATE.md#deployment-findings-2026-10-06)
for credential and storage checks. The service is not deployed.

## Existing self-host build and local validation

Build our source, not the upstream published image:

```sh
EXECUTOR_BUILD_VERSION="$(git rev-parse HEAD)" \
  docker compose -f apps/hosted/self-host/compose.yaml build
```

For a disposable local instance with a new persistent volume:

```sh
EXECUTOR_BUILD_VERSION="$(git rev-parse HEAD)" \
  docker compose -f apps/hosted/self-host/compose.yaml up --detach
curl --fail http://127.0.0.1:4400/health
```

Open `http://127.0.0.1:4400` and create the first administrator. The original
[self-host guide](../apps/hosted/self-host/README.md) describes the volume and keys.
The manual `Build private self-host` workflow only builds our image. It does not
publish an image, expose a service or deploy to Cloudflare.

Cloudflare Tunnel can expose this persistent-host deployment through Cloudflare,
but compute would still run on the host. That is not a Cloudflare-only deployment.

## Preparation checks

The fork preparation passed `bun install --frozen-lockfile` with Bun 1.4.2,
`bun run format`, `bun run check`, Actionlint, Compose configuration validation,
and `git diff --check`. The upstream Effect compiler emitted warnings; the check
exited successfully. No application behavior changed in this preparation.
No browser, MCP or restart-persistence scenario has been run on Cloudflare.
The durable private runtime and deployed acceptance checks remain open work.

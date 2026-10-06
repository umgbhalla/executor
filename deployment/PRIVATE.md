# Private Executor requirements

The owner requested this product on 2026-10-06. This is the accepted scope,
not a claim that the product has been implemented or deployed.

## Product

- Run all compute and persistent storage in the owner's Cloudflare account.
- Use `executor.umgbhalla.com` as the proposed dashboard, API and MCP origin.
- Keep exactly one owner and one internal organization. Disable public signup,
  invitations, additional organizations and provider-based sign-in.
- Pair a browser by pasting an operator-controlled secret. Pairing always grants
  access to the same owner; it must never create another user.
- Allow that owner to enroll multiple passkeys and hardware security keys.
  Use passkeys for ordinary sign-in. Require WebAuthn user verification.
- Retain the manual pairing key as an explicit recovery and enrollment path.
  Keep it out of URLs, logs, browser persistence and source control. Rate-limit
  pairing, expire its enrollment session, and support key rotation.
- Use a separate, expiring, revocable admin API key for agent API and MCP access.
  Pin it to the private organization. It must not serve as a pairing key or
  browser session, or permit enrollment of authentication credentials.
- Reuse Executor's dashboard, app management, account connections, API, MCP and
  isolated authored-app runtime. Preserve product authorization and SSRF checks.
- Keep upstream account, login, billing and analytics services out of the private
  product. Disable or replace the optional upstream registry through its contract.
- Preserve credential encryption and keep its key stable across upgrades.

The pairing key grants access to the owner. It is a privileged recovery secret,
not a second identity. Physical passkey enrollment still needs the owner's device.

```text
Manual pairing key --> short enrollment session --> many owner passkeys
Owner passkey ------> browser session -----------> dashboard and app setup
Owner creates key --> organization-pinned key ---> agent API and MCP
```

## Source and updates

Keep the existing Executor packages as upstream code. Put private product
composition, authentication policy and Cloudflare adapters under a separate
`apps/private-cloud/` product when implementation starts. Share through public
package exports. Add only the small upstream capability exports actually needed.
Do not copy the SDK, fork shared authorization, or remove auth from shared code.

This fork tracks upstream **v2**. Upstream `main` is a different source line;
do not merge it without checking that upstream has moved v2 there. Update the
private branch with merges, preserving its history:

```sh
git fetch upstream v2
git merge upstream/v2
```

Use a task rift for each update. Resolve conflicts, run the named E2E checks and
open a normal PR. Never rebase the maintained private branch. Source separation
reduces conflicts; it cannot promise that all future upstream changes merge
without adaptation. Publishing and merging need explicit authorization.

## Deployment findings: 2026-10-06

The environment was copied with SCP from Hyperion's `~/hub/abdw/.env` into a
private state directory outside Git. Only its three Cloudflare settings were
retained; the temporary full environment copy was removed. Its values were not
printed or committed.

| Check                                          | Result                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                         | Cloudflare returned HTTP 401 on token and account checks                        |
| `CLOUDFLARE_API_ADMIN_TOKEN`                   | Active; token verification, Worker listing and domain lookup succeeded          |
| `umgbhalla.com`                                | One active zone found                                                           |
| Admin token: R2 listing                        | HTTP 403                                                                        |
| Admin token: Durable Object listing            | HTTP 403                                                                        |
| Admin token: DNS record lookup                 | HTTP 403                                                                        |
| Admin token: Worker custom-domain listing      | HTTP 403                                                                        |
| Admin token: permission policy readback        | HTTP 403; write scopes remain unknown                                           |
| Stable session, encryption and pairing secrets | Generated locally with mode 0600; not uploaded                                  |
| New `executor-private-deploy` token            | Created through Helium after confirmation; expires 2026-11-05                   |
| New token: preflight                           | All six checks passed: token, Workers, R2, Durable Objects, zone and DNS        |
| `executor-private-builds`                      | Private R2 bucket created; successful API readback; no public access configured |
| DNS and running service                        | No changes made                                                                 |

The new token grants Workers Scripts Edit and Workers R2 Storage Edit in the
selected account, and DNS Edit, Workers Routes Edit and Zone Read only for
`umgbhalla.com`. R2 bucket creation proves resource-management write access.
Worker deployment, DNS writes and object write/read durability still need their
own checks. The original copied credentials remain unsuitable for deployment.

The deployment token and generated product secrets are in mode-0600 files under
`~/.local/state/executor-private/`. The clipboard was cleared after the new token
was saved. The 1Password CLI is not installed here; move stable product keys to
the operator's secret manager before release. Never replace them on redeploy.

Run the read-only check without exposing credentials:

```sh
node deployment/preflight.mjs --env /private/path/deploy.env
```

The checker emits only check names, HTTP statuses and numeric error codes. A
failed access check exits nonzero. Success still does not mean a runtime exists.

## Runtime blocker

The packaged private server uses PGlite 0.5.8. Its PostgreSQL WebAssembly module
declares a minimum memory of 2,048 pages, or 128 MiB. Starting it with a 32 MiB
`initialMemory` fails with:

```text
memory import has 512 pages which is smaller than the declared initial of 2048
```

Its default allocation already consumes the whole Workers isolate allowance,
before JavaScript, schema, filesystem and request allocations. Cloudflare counts
both JavaScript and WebAssembly within its [128 MB isolate memory limit](https://developers.cloudflare.com/workers/platform/limits/#memory).
The existing PostgreSQL module is therefore not a deployable Workers database.

The private product needs a tested Cloudflare-native storage path, or a different
PostgreSQL module with a proven smaller memory footprint. The existing FumaDB
SQLite adapter can be reused, but hosted schema migrations, raw PostgreSQL SQL,
JSON operations, constraints, locks and auth transactions also need adaptation.
Changing a binding or provider string alone is insufficient.

Containers do not solve durability by themselves: their disk is
[ephemeral](https://developers.cloudflare.com/containers/concepts/architecture/).
Snapshot-only recovery must not replace durability of acknowledged writes.
Do not deploy an empty shell or temporary-disk database as the requested product.

## Release checks

Use real HTTP, MCP and browser scenarios under `e2e/`. Before release, prove:

- Wrong pairing keys fail; concurrent pairing creates exactly one owner.
- New-browser pairing reuses that owner and permits several authenticators.
- Passkey challenges expire, cannot be replayed, and reject foreign origins.
- Password, social sign-in, signup, invites and second-owner creation fail.
- API keys cannot become browser sessions or enroll/revoke authenticators.
- The admin key can perform authorized operations; revoked and expired keys fail.
- App source deploys, tools execute, account credentials remain encrypted, and
  app data persists after Worker replacement and object restart.
- Fresh setup, retained-data upgrades, repeat migration runs, failed-deploy
  recovery, backup and restore work through the real Cloudflare storage adapter.
- Dashboard, app origins, OAuth callbacks and MCP discovery work over HTTPS.

Account access and the build bucket are prepared. Deployment still requires the
runtime/storage port. Pairing, passkey-only policy, the separate private product,
source/build runtime bindings and deployed acceptance checks remain work.

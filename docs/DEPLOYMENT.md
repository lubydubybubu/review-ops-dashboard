# Deployment runbook (dedicated host, container)

> Generic runbook. The CI of this public repository builds the app and runs the tests; it does not build
> the container image or deploy anything. Reverse-proxy / edge configuration is out of scope.

## Shape

- One host dedicated to Ops runs one app container (`review-ops:<git-sha>`) bound to **host loopback
  `127.0.0.1:3000`**; the reverse proxy on that host is the only way in and forwards the
  public Ops origin (`OPS_PUBLIC_ORIGIN`, https) to it.
- A **dedicated database** `review_ops` on the existing PostgreSQL cluster with two roles:
  `ops_owner` (owns the schema; used **only** by the one-shot migrate job) and `ops_app` (runtime, DML only,
  owns nothing, statement timeout). No superuser credential exists on the Ops host.
- Secrets are files under `deploy/secrets/` on the host (git- and docker-ignored, mode 0600, owned by the
  deploy user), mounted as Docker secrets. Images contain no secrets and no `.env` files.

| secret file | used by | content |
| --- | --- | --- |
| `site_client_secret` | app | ≥ 32 random chars; its SHA-256 goes into the site's `ops-handoff.json` |
| `ops_app_database_url` | app | `postgres://ops_app:…@db-host:5432/review_ops?sslmode=…` |
| `ops_owner_database_url` | migrate job only | `postgres://ops_owner:…@db-host:5432/review_ops?sslmode=…` |

Generate the client secret on the host, e.g. `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" > deploy/secrets/site_client_secret`.

## Expected external URLs (app-facing only)

- `<ops-host>` must be **same-site** with the site host the admin logs in on (e.g. `ops.site.example` next to
  `site.example`): the parent-site admin cookie is `SameSite=Strict`, so from a different site the browser never sends
  it and the site refuses such a `redirectUri` (docs/AUTH.md, "SameSite=Strict and the Ops domain").
- Browser → `https://<ops-host>/` (any path); `/auth/start`, `/auth/callback` must reach the app unchanged.
  The proxy must preserve `Host` (or set `X-Forwarded-Host`) = `<ops-host>`: Next.js rejects Server Actions
  whose `Origin` does not match it, and Ops additionally requires `Origin` == `OPS_PUBLIC_ORIGIN` exactly.
- The site's handoff config must list exactly `https://<ops-host>/auth/callback` as `redirectUri`.
- Browser → `https://site.example/admin/ops-handoff/` (no confirm page: a valid admin GET gets a direct 303
  to the Ops callback) sits under `/admin/`, so the edge access policy for `/admin/*` and the admin login
  guard it like every admin page.
- Ops → site back channel: `POST https://site.example/api/ops-handoff/{token,introspect,revoke}` from the Ops
  host — outside `/admin/` and `/api/admin/` on purpose (server-to-server, client-secret authenticated, no
  browser cookie); must not be cached, challenged (bot checks / access login) or rewritten by the edge, and
  must carry the `Authorization` header through. The site allows 120 calls/min from one client: keep
  `OPS_AUTH_REVALIDATE_SECONDS` at its default (30) in production.
- If the proxy in front of Ops sets a trustworthy client-IP header, set `OPS_TRUSTED_CLIENT_IP_HEADER`
  (e.g. `x-real-ip`); otherwise leave it empty. Then the sign-in routes share one bucket
  (20/min) and at most 50 sign-ins may be pending, so a flood can delay the owner's login by a few minutes
  (it cannot get anyone in) — configure the header in production.

## First install

1. **Database (cluster admin, once):** `psql -v owner_password=… -v app_password=… -f db/bootstrap/001-roles-and-database.sql`
   (passwords from files, not typed into history). Put the two URLs into the secret files.
2. **Images (build host):** `docker build --target runtime -t review-ops:<sha> .` and
   `docker build --target migrate -t review-ops-migrate:<sha> .` Pin `NODE_IMAGE` by digest first (Dockerfile header).
3. **Config:** copy `deploy/ops.env.example` → `deploy/ops.env`, fill in origins/image tags. The identity is
   fixed to the parent-site admin login (`OPS_IDENTITY_KIND=admin` in the Compose file); there is no owner id to
   configure, and a leftover `OPS_OWNER_SUBJECT` makes the app refuse to enable sign-in.
4. **Migration gate:** `docker compose -f deploy/compose.yaml --env-file deploy/ops.env run --rm migrate` — must exit 0
   (applies `db/migrations/*` from zero, re-grants DML to `ops_app`).
5. **Start:** `docker compose -f deploy/compose.yaml --env-file deploy/ops.env up -d app`; wait for
   `healthy` (`/api/health` → `{"status":"ok"}`).
6. **Site side:** the parent site must implement the contract in docs/AUTH.md and be configured with
   `clientId`, the exact `redirectUri` `https://<ops-host>/auth/callback` and the SHA-256 of the client
   secret. Until then Ops shows the login page and the handoff answers 503. If the site keeps grants in
   memory only, a site restart means the admin signs in to Ops again.

Startup never migrates and never seeds: `db:seed` (fictional demo data) refuses to run with
`OPS_DEPLOYMENT=production`, and `demo-password` sign-in is refused in production.

## Every release

1. **Backup first:** `pg_dump -Fc -d "<ops_owner url>" -f review_ops-<date>-<sha>.dump` (keep ≥ 7 daily + the
   pre-release dumps of the last 3 releases, off the host). Test-restore a dump into a scratch database
   monthly: `pg_restore --no-owner -d scratch review_ops-….dump`.
2. Build both images for the new `<sha>`; update `OPS_IMAGE` / `OPS_MIGRATE_IMAGE`.
3. Run the migrate job (gate). Non-zero exit ⇒ stop; nothing else changed.
4. `up -d app`; confirm `healthy`, sign in, open the dashboard.

## Rollback

- **App only (no new migration):** set `OPS_IMAGE` back to the previous tag, `up -d app`.
- **With a migration:** migrations are forward-only. Either keep the new schema and roll the app back only
  if the migration was additive (the default policy: add columns/tables, never drop in the same release),
  or restore the pre-release dump (`pg_restore --clean --if-exists -d "<owner url>" …`), re-run
  `migrate` with the previous image, then start the previous app image.
- **Sign-in emergency:** log out of the site admin / change the admin password (ends every grant within the
  revalidation window), disable the handoff in the site's config (immediate) and/or end every Ops
  session: `docker compose -f deploy/compose.yaml --env-file deploy/ops.env run --rm -e DATABASE_URL_FILE=/run/secrets/ops_owner_database_url --entrypoint node migrate --import tsx scripts/revoke-sessions.ts`.

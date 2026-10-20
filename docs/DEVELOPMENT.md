# How this project is developed

Review Ops is designed and directed by its owner. Code is written with AI coding agents under a fixed
split of roles, so that no single agent both writes and approves a change.

| role | who | what |
| --- | --- | --- |
| requirements, decisions, acceptance | owner | scope, workflow, data model, identity/security decisions, go/no-go for any deployment |
| implementation | AI coding agent | writes code, tests and docs for a batch; runs the local test suites |
| independent verification | a separate reviewer model | reviews and re-tests the batch separately from the implementer |

## Status of this public repository

- Implemented: phase 1 (review schedule), parent-site admin sign-in handoff (Ops side) and server-side
  sessions (docs/AUTH.md), protected pages and actions checked server-side, CSRF origin checks, health
  endpoint, container/Compose/DB bootstrap artifacts and runbook (docs/DEPLOYMENT.md), widget API
  contract draft (docs/WIDGET-API.md), mail-request inbox with its ingest route and `mail-ingest/` producer.
- Verified by this repository's CI on every push: lint, typecheck, unit tests, integration tests against
  a throw-away PostgreSQL 17 service (DML-only role), production build, browser E2E (the runner's
  Chrome + `openssl`, against the **synthetic** parent-site fixture), producer tests
  (`python3 mail-ingest/test_post_candidates.py`), secret scan.
- Not in this repository: the parent site's implementation of the handoff contract, a native widget, and
  one-way sync of published posts from the parent site (planned: idempotent upsert keyed by the site's
  post id, never overwriting fields edited in Ops, never auto-publishing or deleting).

## Saved views

- Migration `007-saved-views.sql` adds `saved_views`. Apply migrations with `--grant <app role>` before
  starting the new build so the runtime role has DML privileges on the new table.
- `?v=<id>` selects a view; `?cfg=<json>` holds an unsaved draft; `?base=<version>` pins its original
  compare-and-set token. Drafts without a base require save-as-new or explicit overwrite confirmation.
- One server-side zod schema validates config values; closed property/operator maps compile them to
  parameterized SQL. Client components use the zod-free config module. Dates are restricted to
  1900-01-01 through 2999-12-31; text and view names reject C0 control characters.

## Mail requests

- Migration `008-mail-candidates.sql` adds `mail_candidates`; re-grant runtime DML before starting the new build.
- `POST /api/ingest/mail-candidates` checks, in order: exact `OPS_INGEST_ALLOWED_HOST` and no `cf-connecting-ip` /
  `cf-ray` header, TCP peer in `OPS_INGEST_ALLOWED_CIDRS` (needs `node --import ./scripts/peer-address.mjs`),
  bearer token against its SHA-256, rate limit, zod schema. It writes candidate rows only.
- The mailbox read and LLM extraction are not part of this repository; synthetic candidates drive the tests.

## Demo mode

- All brands, products and reviews in the seed and screenshots are **fictional**.
- `OPS_AUTH_MODE=demo-password` exists for local demos and tests only and is refused when
  `OPS_DEPLOYMENT=production`; `npm run db:seed` is refused there too.
- Tests never use real credentials: the integration/E2E harnesses refuse any database that is not on
  loopback at the disposable test port, and only drop databases they generated themselves.

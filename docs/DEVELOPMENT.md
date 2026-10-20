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
  contract draft (docs/WIDGET-API.md).
- Verified by this repository's CI on every push: lint, typecheck, unit tests, integration tests against
  a throw-away PostgreSQL 17 service (DML-only role), production build, secret scan.
- Browser E2E (`npm run test:e2e`) runs locally with a system Chrome and `openssl` against the
  **synthetic** parent-site fixture; it is not part of CI here.
- Not in this repository: the parent site's implementation of the handoff contract, a native widget, and
  one-way sync of published posts from the parent site (planned: idempotent upsert keyed by the site's
  post id, never overwriting fields edited in Ops, never auto-publishing or deleting).

## Demo mode

- All brands, products and reviews in the seed and screenshots are **fictional**.
- `OPS_AUTH_MODE=demo-password` exists for local demos and tests only and is refused when
  `OPS_DEPLOYMENT=production`; `npm run db:seed` is refused there too.
- Tests never use real credentials: the integration/E2E harnesses refuse any database that is not on
  loopback at the disposable test port, and only drop databases they generated themselves.

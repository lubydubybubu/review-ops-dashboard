# Future: read-only widget API (contract draft — nothing implemented)

> Design note only. **No widget API, token issuance or native (iOS/Android) widget exists in this
> repository.** This fixes the contract so the browser session model above does not have to change later.

## Goal

A home-screen widget shows a few numbers (overdue reviews, today's schedule) without a browser session and
without any power to change data.

## Credentials: per-device, scoped, revocable

- The owner creates a **device token** from a signed-in Ops page ("위젯 기기 추가"), names the device, and
  sees the token **once** (or scans it as a QR code into the containing app).
- Token = 256-bit random, opaque (no JWT). Stored as SHA-256 in a future `device_tokens` table:
  `id, name, token_hash unique, scopes text[] check (scopes <@ array['widget:read']), created_at,
  last_used_at, expires_at (≤ 180 days), revoked_at`.
- One scope for now: `widget:read`. The token can never call server actions, sign in, or reach any other route.
- Revocation: list of devices on the settings page, revoke = `revoked_at = now()`, effective on the next
  request. Ending all browser sessions does **not** revoke device tokens and vice versa; a separate
  "revoke all devices" action exists. Rotating the parent-site client secret has no effect on device tokens.
- The containing app may additionally protect its stored token with the platform keychain and device
  authentication (Face ID / passcode); that is the app's concern and does not change the server contract.

## Endpoint

`GET /api/widget/v1/summary` with `Authorization: Bearer <device token>`

- 200 `application/json`, `Cache-Control: private, no-store`:
  `{ "generated_at": "<ISO-8601>", "today": "YYYY-MM-DD", "overdue": 3, "due_this_week": 10,
     "next": [{ "kind": "shoot" | "write_due" | "publish_planned" | "embargo", "date": "YYYY-MM-DD",
                "time": "HH:MM" | null, "title": "<product name, ≤ 80 chars>" }] }` (≤ 5 items)
- 401 for missing/unknown/revoked/expired tokens (same body, no detail); 429 with `Retry-After` when the
  per-token limit (e.g. 60/hour) is exceeded.
- No notes, brand contacts, checklists or anything beyond the fields above; titles may be hidden by a
  per-device "privacy" flag (counts only).
- Never accepts cookies; never sets cookies; CORS closed.

## Out of scope until a separate, approved phase

Native widget code, push notifications, write access of any kind, multi-user sharing.

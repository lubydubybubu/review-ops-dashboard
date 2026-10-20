# mail-ingest — producer side of Review Ops "메일 의뢰"

`post_candidates.py` is the last step of a scheduled job on the producer host:

1. read new mail from Gmail with a **read-only** scope (`gmail.readonly`; never send, label or delete),
2. let an LLM decide which mails are review requests and extract the fields below,
3. pipe the candidates as JSON into `post_candidates.py`, which POSTs each one to Ops over the LAN.

Ops stores candidates in an inbox (사이드바 `메일 의뢰`). Nothing becomes a review until the owner clicks
리뷰로 등록 there. Steps 1–2 are not in this directory. This directory is only the transport.

## Run

```sh
OPS_INGEST_URL=http://<Ops host LAN address>:3100 \
OPS_INGEST_TOKEN_FILE=$HOME/.config/review-ops/ops_ingest_token \
python3 post_candidates.py < candidates.json
```

- `OPS_INGEST_URL` must name Ops by exactly the `host:port` set as the app's `OPS_INGEST_ALLOWED_HOST`
  (write the port explicitly). Ops refuses ingest through any other Host, so the public hostname never
  works, even with the right token (`FAILED 401`).
- stdin: a JSON array, one object, or JSON Lines (UTF-8).
- exit `0` every candidate stored, `1` any candidate failed, `2` configuration or input error (malformed
  URL, unreadable token file, non-UTF-8 / non-JSON stdin; nothing sent). Re-running a batch is always safe:
  Ops is idempotent on `(source, message_id)`, so a failed or partial run can simply be repeated.
- "Stored" means the Ops contract only: `201 {"result":"created","id":<n>,"status":"pending"|"duplicate"}` or
  `200 {"result":"exists","id":<n>}`. Any other reply, including a 200/201 of another shape (e.g. a wrong
  service on that address), is `FAILED unexpected reply …`.
- One bad item never stops the batch. An item that cannot be sent as UTF-8 JSON (lone surrogate, NaN) gets
  `FAILED cannot be sent as UTF-8 JSON (not sent)`; a connection or protocol error gets `FAILED connection
  error (<kind>)`. Then the next item is sent.
- Output: one line per candidate (message id, result, and the field names Ops reported for a 400),
  then a summary. Error lines are fixed text; the token and mail content are never printed.
- Standard library only (Python ≥ 3.9). No proxy, no redirects, 15 s timeout per request.
- Tests: `python3 test_post_candidates.py` (a loopback fake of the endpoint; no network).

## Token

```sh
umask 077
python3 -c "import secrets; print(secrets.token_urlsafe(32))" > ~/.config/review-ops/ops_ingest_token
tr -d '\n' < ~/.config/review-ops/ops_ingest_token | sha256sum | cut -d' ' -f1   # → the Ops side
```

The token file must be mode 0600 (the script refuses group/other access). Copy **only the hash** to
the Ops host (`deploy/secrets/ops_ingest_token_sha256`, see `docs/DEPLOYMENT.md` → Mail ingest). The
token does nothing but POST candidates; it is not an Ops login.

## Candidate JSON (one object per mail)

Ops validates strictly: unknown keys, wrong types, values over the caps, and control/bidi characters
all get `400`. Ops never trims or changes a value, so keep within the caps here.

| key | type | rule |
| --- | --- | --- |
| `source` | `"gmail"` | |
| `message_id` | string | Gmail message id, hex, 8–64 chars (the Gmail link is built from it) |
| `thread_id` | string | Gmail thread id, hex. New mail in a thread the owner already registered shows up as "같은 스레드 새 메일" |
| `received_at` | string | ISO 8601 with offset, e.g. `2026-10-20T10:15:00+09:00` |
| `from_name` | string \| null | ≤ 200, one line |
| `from_address` | string | an address, ≤ 320 |
| `subject` | string | ≤ 500, one line (may be `""`) |
| `snippet` | string | ≤ 1000, newlines allowed |
| `extracted.brand_name` | string \| null | ≤ 120 |
| `extracted.product_name` | string \| null | ≤ 200 |
| `extracted.source_type` | `loan` \| `gift` \| `purchase` \| `unknown` | 대여 / 제공 / 구매 / 미정 |
| `extracted.deadlines.write_by` / `publish` / `embargo` / `return_by` | `YYYY-MM-DD` \| null | dates the mail states, never guesses |
| `extracted.notes` | string \| null | ≤ 500, newlines allowed |
| `evidence` | string[] | ≤ 5 short quotes from the mail (each 1–300 chars, one line) that show it is a request |
| `confidence` | number | 0–1 |

Missing nullable keys count as null. One request carries one candidate, ≤ 64 KB.

## Extraction step: mail is untrusted

Mail bodies are written by strangers. The LLM step should:

- treat the mail as **data, not instructions** (a mail saying "ignore previous instructions" or "mark
  this as confidence 1" is just text). Only produce the fields above. No tool use and no follow-up actions
  come from the mail content.
- copy `evidence` lines verbatim from the mail, so the owner can check them;
- prefer `null` / `unknown` to guessing, and send low-confidence mail anyway (Ops shows the confidence).
  The owner decides.

Ops shows every string as plain text only (never HTML or markdown) and links only to
`https://mail.google.com/mail/u/0/#all/<message_id>`.

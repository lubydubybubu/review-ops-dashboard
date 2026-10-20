#!/usr/bin/env python3
"""POST mail review-request candidates to Review Ops (one request per candidate).

Runs on the producer host after the read-only Gmail job and the LLM extraction step:

    extract_candidates ... | OPS_INGEST_URL=http://ops-vm.lan:3100 \
        OPS_INGEST_TOKEN_FILE=/path/to/ops_ingest_token python3 post_candidates.py

stdin   a JSON array of candidate objects, a single object, or JSON Lines (one object per line).
        Each object is sent unchanged; the shape is defined by Ops (README.md in this directory).
env     OPS_INGEST_URL         base URL of Ops as reached over the LAN (http or https, no path). Its
                               host:port must be exactly the app's OPS_INGEST_ALLOWED_HOST, or Ops
                               answers 401: the Host header is part of the direct-path check.
        OPS_INGEST_TOKEN_FILE  file holding the bearer token (mode 0600; never printed)
stdout  one line per candidate, then a summary. Never prints the token or mail content; only the
        message id, the HTTP status and the field names Ops reports for a 400. Errors are fixed text.
exit    0 every candidate stored: 201 {"result":"created","id","status"} or 200 {"result":"exists","id"}.
          Any other reply, even a 200/201 of another shape, is a failure, not "stored".
        1 at least one candidate failed (it was not stored; re-running is safe, Ops is idempotent).
          A failed item never stops the batch: an item that cannot be encoded as UTF-8 JSON, or a
          connection / protocol error, is reported on its line and the next item is sent.
        2 usage / configuration error, including a malformed OPS_INGEST_URL or non-UTF-8 stdin
          (nothing was sent)

Standard library only. No proxies (the token must not pass through one), no redirects, 15 s timeout.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request

ENDPOINT = "/api/ingest/mail-candidates"
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
HEX_RE = re.compile(r"^[0-9a-fA-F]{1,64}$")
# a DNS name, IPv4 address or (bracket-less, as urlsplit returns it) IPv6 literal
HOST_RE = re.compile(r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?)+$|^[0-9A-Fa-f:.]+$")
TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 8 * 1024


class ConfigError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102 (stdlib signature)
        return None  # a redirect is reported as a failure, never followed with the token


def endpoint_url(base: str | None) -> str:
    if not base:
        raise ConfigError("OPS_INGEST_URL is not set")
    try:
        if not base.isascii():
            raise ValueError
        parsed = urllib.parse.urlsplit(base.strip())
        host, port = parsed.hostname, parsed.port  # both raise ValueError on a malformed authority
    except ValueError:
        raise ConfigError("OPS_INGEST_URL must be an http(s) URL") from None
    if parsed.scheme not in ("http", "https") or not host or not HOST_RE.fullmatch(host) or port == 0:
        raise ConfigError("OPS_INGEST_URL must be an http(s) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ConfigError("OPS_INGEST_URL must be a bare base URL (scheme://host[:port])")
    return f"{parsed.scheme}://{parsed.netloc}{ENDPOINT}"


def read_token(path: str | None) -> str:
    if not path:
        raise ConfigError("OPS_INGEST_TOKEN_FILE is not set")
    try:
        info = os.stat(path)
        if os.name == "posix" and info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise ConfigError("OPS_INGEST_TOKEN_FILE must not be accessible by group/others (chmod 600)")
        with open(path, encoding="utf-8") as handle:
            token = handle.read().strip()
    except (OSError, ValueError):  # ValueError: not UTF-8 (UnicodeDecodeError), NUL in the path
        raise ConfigError("OPS_INGEST_TOKEN_FILE is not readable") from None
    if not TOKEN_RE.fullmatch(token):
        raise ConfigError("OPS_INGEST_TOKEN_FILE does not hold a token (43-128 base64url characters)")
    return token


def read_candidates(text: str) -> list:
    text = text.strip()
    if not text:
        return []
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        try:  # JSON Lines
            return [json.loads(line) for line in text.splitlines() if line.strip()]
        except (json.JSONDecodeError, RecursionError):
            raise ConfigError("stdin is not JSON (array, object or JSON Lines)") from None
    except RecursionError:
        raise ConfigError("stdin is not JSON (array, object or JSON Lines)") from None
    return value if isinstance(value, list) else [value]


def label(candidate: object) -> str:
    message_id = candidate.get("message_id") if isinstance(candidate, dict) else None
    return message_id.lower() if isinstance(message_id, str) and HEX_RE.fullmatch(message_id) else "(no message_id)"


def encode(candidate: dict) -> bytes | None:
    """The request body as strict UTF-8 JSON; None when the item cannot be sent (lone surrogate, NaN, ...)."""
    try:
        return json.dumps(candidate, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError, RecursionError):  # UnicodeEncodeError is a ValueError
        return None


def post(opener: urllib.request.OpenerDirector, url: str, token: str, body: bytes) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "User-Agent": "review-ops-mail-ingest/1",
        },
    )
    try:
        with opener.open(request, timeout=TIMEOUT_SECONDS) as response:
            return response.status, _json(response.read(MAX_RESPONSE_BYTES))
    except urllib.error.HTTPError as error:
        return error.code, _json(error.read(MAX_RESPONSE_BYTES))


def _json(raw: bytes) -> dict:
    try:
        value = json.loads(raw.decode("utf-8"))
        return value if isinstance(value, dict) else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}


def stored(status: int, reply: dict) -> bool:
    """Only the Ops success contract counts as stored: 201 created + id + status, or 200 exists + id."""
    candidate_id = reply.get("id")
    if type(candidate_id) is not int or candidate_id < 1:  # noqa: E721 (bool is an int subclass)
        return False
    if status == 201:
        return reply.get("result") == "created" and reply.get("status") in ("pending", "duplicate")
    return status == 200 and reply.get("result") == "exists"


def describe(status: int, reply: dict) -> tuple[bool, str]:
    if status in (200, 201) and not stored(status, reply):
        return False, f"FAILED unexpected reply to HTTP {status} (not the Ops ingest contract; check OPS_INGEST_URL)"
    if status == 201:
        state = reply["status"]
        note = " · same thread as an accepted request" if state == "duplicate" else ""
        return True, f"created id={reply['id']} ({state}){note}"
    if status == 200:
        return True, f"already stored id={reply['id']}"
    if status == 400:
        fields = reply.get("fields")
        names = ", ".join(str(f) for f in fields[:10]) if isinstance(fields, list) else "?"
        return False, f"FAILED 400 invalid ({names})"
    if status == 401:
        return False, "FAILED 401 unauthorized (token or allowlist)"
    if status == 413:
        return False, "FAILED 413 body too large"
    if status == 429:
        return False, "FAILED 429 rate limited (re-run later)"
    return False, f"FAILED HTTP {status}"


def main() -> int:
    try:
        url = endpoint_url(os.environ.get("OPS_INGEST_URL"))
        token = read_token(os.environ.get("OPS_INGEST_TOKEN_FILE"))
        try:
            text = sys.stdin.buffer.read().decode("utf-8")
        except (UnicodeDecodeError, OSError):
            raise ConfigError("stdin is not UTF-8 text") from None
        candidates = read_candidates(text)
    except ConfigError as error:
        print(f"post_candidates: {error}", file=sys.stderr)
        return 2

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    total = len(candidates)
    failed = 0
    for index, candidate in enumerate(candidates, start=1):
        prefix = f"[{index}/{total}] {label(candidate)}"
        if not isinstance(candidate, dict):
            failed += 1
            print(f"{prefix} FAILED not a JSON object (not sent)")
            continue
        body = encode(candidate)
        if body is None:
            failed += 1
            print(f"{prefix} FAILED cannot be sent as UTF-8 JSON (not sent)")
            continue
        try:
            status, reply = post(opener, url, token, body)
            ok, text = describe(status, reply)
        except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as error:
            # fixed text: only the exception class name, never its message (it could quote the reply)
            reason = getattr(error, "reason", error)
            ok, text = False, f"FAILED connection error ({type(reason).__name__})"
        if not ok:
            failed += 1
        print(f"{prefix} {text}")

    print(f"post_candidates: {total - failed} stored, {failed} failed ({total} total)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

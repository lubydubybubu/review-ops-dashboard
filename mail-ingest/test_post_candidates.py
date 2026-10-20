#!/usr/bin/env python3
"""Tests for post_candidates.py against a loopback fake of the Ops endpoint (standard library only).

    python3 test_post_candidates.py        (or: python3 -m unittest -v test_post_candidates)

Every run of the script is checked for: the expected exit code, no traceback, and neither the token nor
any mail text in its output.
"""

from __future__ import annotations

import http.server
import json
import os
import secrets
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "post_candidates.py"
MAIL = "PRIVATE_MAIL_SENTINEL"
ID_A = "abcdef1234567890"
ID_B = "abcdef1234567891"


class FakeOps(http.server.BaseHTTPRequestHandler):
    """Answers each POST with the next (status, body) in `replies`; body None = a non-HTTP reply."""

    replies: list = []
    seen: list = []

    def log_message(self, *args):  # keep test output clean
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        FakeOps.seen.append(self.rfile.read(length))
        status, body = FakeOps.replies.pop(0) if FakeOps.replies else (201, created(1))
        if body is None:
            self.wfile.write(b"garbage that is not HTTP\r\n\r\n")
            self.close_connection = True
            return
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def created(i, status="pending"):
    return {"result": "created", "id": i, "status": status}


def candidate(message_id=ID_A, **extra):
    return {"message_id": message_id, "subject": MAIL, **extra}


class PostCandidatesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeOps)
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()
        cls.scratch = tempfile.TemporaryDirectory(prefix="post-candidates-")
        cls.token = secrets.token_urlsafe(32)
        cls.token_file = Path(cls.scratch.name) / "token"
        cls.token_file.write_text(cls.token)
        cls.token_file.chmod(0o600)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.scratch.cleanup()

    def setUp(self):
        FakeOps.replies = []
        FakeOps.seen = []

    def run_script(self, stdin, expected_exit, replies=(), env=None):
        FakeOps.replies = list(replies)
        base = {k: v for k, v in os.environ.items() if not k.startswith("OPS_")}
        base.update(
            OPS_INGEST_URL=f"http://127.0.0.1:{self.server.server_port}",
            OPS_INGEST_TOKEN_FILE=str(self.token_file),
            PYTHONIOENCODING="utf-8",
        )
        base.update(env or {})
        data = stdin if isinstance(stdin, bytes) else stdin.encode("utf-8", "surrogatepass")
        result = subprocess.run([sys.executable, str(SCRIPT)], input=data, capture_output=True, env=base, timeout=30)
        out = (result.stdout + result.stderr).decode("utf-8", "replace")
        self.assertNotIn("Traceback", out)
        self.assertNotIn(self.token, out)
        self.assertNotIn(MAIL, out)
        self.assertEqual(result.returncode, expected_exit, out)
        return out

    # ------------------------------------------------------------ N3: the success contract

    def test_contract_replies_are_stored(self):
        out = self.run_script(
            json.dumps([candidate(ID_A), candidate(ID_B)]),
            0,
            replies=[(201, created(7, "duplicate")), (200, {"result": "exists", "id": 3})],
        )
        self.assertIn(f"[1/2] {ID_A} created id=7 (duplicate)", out)
        self.assertIn(f"[2/2] {ID_B} already stored id=3", out)
        self.assertIn("2 stored, 0 failed (2 total)", out)

    def test_wrong_service_200_is_a_failure(self):
        out = self.run_script(json.dumps(candidate()), 1, replies=[(200, {"error": "wrong service"})])
        self.assertIn("FAILED unexpected reply to HTTP 200", out)
        self.assertNotIn("already stored", out)
        self.assertIn("0 stored, 1 failed (1 total)", out)

    def test_malformed_success_shapes_are_failures(self):
        bad = [
            (201, {"result": "created", "id": 1}),  # no status
            (201, {"result": "created", "id": "1", "status": "pending"}),  # id not an integer
            (201, {"result": "created", "id": True, "status": "pending"}),  # bool is not an id
            (201, {"result": "created", "id": 0, "status": "pending"}),
            (201, {"result": "created", "id": 1, "status": "accepted"}),  # not a status ingest returns
            (201, {"result": "exists", "id": 1, "status": "pending"}),  # 201 must say created
            (200, {"result": "created", "id": 1, "status": "pending"}),  # 200 must say exists
            (200, {"id": 1}),
            (201, b"not json"),
            (201, b"[1, 2]"),
        ]
        batch = "\n".join(json.dumps(candidate(f"{i:016x}")) for i in range(len(bad)))
        out = self.run_script(batch, 1, replies=bad)
        self.assertEqual(out.count("FAILED unexpected reply to HTTP"), len(bad), out)
        self.assertIn(f"0 stored, {len(bad)} failed ({len(bad)} total)", out)

    def test_one_failure_makes_the_exit_non_zero(self):
        out = self.run_script(
            json.dumps([candidate(ID_A), candidate(ID_B)]),
            1,
            replies=[(201, created(1)), (200, {"error": "wrong service"})],
        )
        self.assertIn("1 stored, 1 failed (2 total)", out)

    # ------------------------------------------------------------ N4: controlled errors

    def test_malformed_url_is_a_config_error(self):
        for url in ("http://[", "http://[::1", "http://127.0.0.1:99999", "http://127.0.0.1:port", "http://exa mple.test"):
            with self.subTest(url=url):
                out = self.run_script(json.dumps(candidate()), 2, env={"OPS_INGEST_URL": url})
                self.assertIn("post_candidates: OPS_INGEST_URL", out)
                self.assertEqual(FakeOps.seen, [])

    def test_undecodable_token_file_is_a_config_error(self):
        path = Path(self.scratch.name) / "binary-token"
        path.write_bytes(b"\xff\xfe" + b"a" * 50)
        path.chmod(0o600)
        out = self.run_script(json.dumps(candidate()), 2, env={"OPS_INGEST_TOKEN_FILE": str(path)})
        self.assertIn("post_candidates: OPS_INGEST_TOKEN_FILE", out)

    def test_undecodable_stdin_is_an_input_error(self):
        out = self.run_script(b'[{"message_id":"' + ID_A.encode() + b'","subject":"\xff\xfe' + MAIL.encode() + b'"}]', 2)
        self.assertIn("post_candidates: stdin", out)
        self.assertEqual(FakeOps.seen, [])

    def test_unencodable_item_fails_alone_and_the_batch_continues(self):
        # json.loads accepts a lone surrogate and NaN; neither can be sent as strict UTF-8 JSON
        stdin = "[" + ",".join(
            [
                '{"message_id":"%s","subject":"%s \\ud800"}' % (ID_A, MAIL),
                '{"message_id":"%s","subject":"%s","confidence":NaN}' % ("abcdef1234567892", MAIL),
                json.dumps(candidate(ID_B)),
            ]
        ) + "]"
        out = self.run_script(stdin, 1, replies=[(201, created(9))])
        self.assertIn(f"[1/3] {ID_A} FAILED cannot be sent as UTF-8 JSON (not sent)", out)
        self.assertIn("[2/3] abcdef1234567892 FAILED cannot be sent as UTF-8 JSON (not sent)", out)
        self.assertIn(f"[3/3] {ID_B} created id=9 (pending)", out)
        self.assertIn("1 stored, 2 failed (3 total)", out)
        self.assertEqual(len(FakeOps.seen), 1)

    def test_non_http_reply_fails_the_item_and_the_batch_continues(self):
        out = self.run_script(json.dumps([candidate(ID_A), candidate(ID_B)]), 1, replies=[(0, None), (201, created(2))])
        self.assertIn(f"[1/2] {ID_A} FAILED connection error", out)
        self.assertIn(f"[2/2] {ID_B} created id=2 (pending)", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)

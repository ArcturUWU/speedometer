"""Local dashboard boundaries and API integration without external traffic."""
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

import speedometer


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.server = speedometer.LocalServer(("127.0.0.1", 0))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.dashboard.cancel.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def call(self, path, body=None, token=None, headers=None):
        headers = dict(headers or {})
        if token:
            headers["X-Speedometer-Token"] = token
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.url + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        with urlopen(request, timeout=2) as response:
            return json.load(response)

    def test_ready_state_and_url_validation(self):
        state = self.call("/api/status")
        self.assertEqual(state["status"], "ready")
        self.assertTrue(state["token"])
        with self.assertRaises(HTTPError) as error:
            self.call("/api/start", {"url": "file:///etc/passwd"}, state["token"])
        self.assertEqual(error.exception.code, 400)
        self.assertEqual(self.call("/api/status")["status"], "ready")

    def test_external_page_and_missing_token_cannot_start_download(self):
        state = self.call("/api/status")
        for token, headers in [(None, {}), (state["token"], {"Origin": "https://other.example"})]:
            with self.assertRaises(HTTPError) as error:
                self.call("/api/start", {"url": speedometer.DEFAULT_URL}, token, headers)
            self.assertEqual(error.exception.code, 403)

    def test_non_ascii_token_is_rejected_with_http_response(self):
        # HTTP headers can contain Latin-1, while compare_digest(str, str)
        # requires ASCII: an invalid token must still receive a clean 403.
        with self.assertRaises(HTTPError) as error:
            self.call("/api/start", {"url": speedometer.DEFAULT_URL}, token="\u00e9")
        self.assertEqual(error.exception.code, 403)
        self.assertEqual(self.call("/api/status")["status"], "ready")

    def test_wrong_host_and_unknown_files_rejected(self):
        with self.assertRaises(HTTPError) as error:
            self.call("/api/status", headers={"Host": "other.example"})
        self.assertEqual(error.exception.code, 403)
        with self.assertRaises(HTTPError) as error:
            self.call("/../meter.py")
        self.assertEqual(error.exception.code, 404)

    def test_busy_conflict_and_cancel_reaches_worker(self):
        entered = threading.Event()
        finished = threading.Event()

        def fake_measure(url, on_event, cancel):
            entered.set()
            cancel.wait(2)
            finished.set()
            return {"url": url, "status": "cancelled", "samples": [],
                    "stats": self.server.dashboard.ready()["stats"]}

        token = self.call("/api/status")["token"]
        with patch.object(speedometer, "measure", fake_measure):
            self.assertEqual(self.call("/api/start", {"url": speedometer.DEFAULT_URL}, token)["status"], "running")
            self.assertTrue(entered.wait(1))
            with self.assertRaises(HTTPError) as error:
                self.call("/api/start", {"url": speedometer.DEFAULT_URL}, token)
            self.assertEqual(error.exception.code, 409)
            self.call("/api/cancel", {}, token)
            self.assertTrue(finished.wait(1))


if __name__ == "__main__":
    unittest.main()

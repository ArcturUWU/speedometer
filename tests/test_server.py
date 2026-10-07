"""Local dashboard boundaries and API integration without external traffic."""
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

import speedometer


class TelemetryTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.clock = patch.object(speedometer.time, "perf_counter", lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.thread = patch.object(speedometer.threading, "Thread")
        self.thread.start()
        self.addCleanup(self.thread.stop)
        self.dashboard = speedometer.Dashboard()

    def run_measure(self, emit_samples, status="completed"):
        self.dashboard.start(speedometer.DEFAULT_URL)

        def fake_measure(url, on_event, cancel):
            emit_samples(on_event)
            snapshot = self.dashboard.snapshot()
            return {"url": url, "status": status, "samples": snapshot["samples"], "stats": snapshot["stats"]}

        with patch.object(speedometer, "measure", fake_measure):
            self.dashboard.worker(speedometer.DEFAULT_URL, self.dashboard.state["id"], self.dashboard.cancel)

    @staticmethod
    def sample(index, byte_count, elapsed, error=None):
        mbps = byte_count * 8 / 1_000_000 / elapsed if elapsed else 0
        return {"index": index, "bytes": byte_count, "elapsed_s": elapsed,
                "mbps": mbps, "MBps": mbps / 8, "error": error}

    def test_live_transfer_is_real_and_setup_does_not_reset_speed(self):
        def emit_samples(emit):
            self.now = 100.5
            emit({"type": "progress", **self.sample(1, 0, 0)})
            self.assertEqual(self.dashboard.snapshot()["trace"], [])
            self.assertEqual(self.dashboard.snapshot()["live_mbps"], 0)
            first = self.sample(1, 1_000_000, .5)
            self.now = 101
            emit({"type": "progress", **first})
            self.assertEqual(self.dashboard.snapshot()["downloaded_bytes"], 1_000_000)
            self.now = 101.2
            self.assertAlmostEqual(self.dashboard.snapshot()["elapsed_s"], 1.2)
            self.now = 101.3
            emit({"type": "sample", "sample": first})
            self.assertEqual(len(self.dashboard.snapshot()["trace"]), 1)
            self.now = 101.5
            emit({"type": "progress", **self.sample(2, 0, 0)})
            snapshot = self.dashboard.snapshot()
            self.assertEqual(snapshot["live_mbps"], 16)
            self.assertEqual(snapshot["current_bytes"], 0)
            self.assertEqual(snapshot["current_elapsed_s"], 0)
            self.assertEqual(snapshot["downloaded_bytes"], 1_000_000)
            self.assertEqual(len(snapshot["trace"]), 1)
            self.now = 102.5
            second = self.sample(2, 500_000, 1, "Incomplete response")
            emit({"type": "progress", **second})
            emit({"type": "sample", "sample": second})
            self.now = 104

        self.run_measure(emit_samples, "partial")
        snapshot = self.dashboard.snapshot()
        self.assertEqual(snapshot["elapsed_s"], 4)
        self.assertEqual(snapshot["downloaded_bytes"], 1_500_000)
        self.assertEqual(snapshot["stats"]["total_bytes"], 1_000_000)
        self.assertEqual(snapshot["stats"]["successful"], 1)
        self.assertEqual(snapshot["stats"]["failed"], 1)
        self.assertEqual(snapshot["current_bytes"], 500_000)
        self.assertEqual(snapshot["current_elapsed_s"], 1)
        self.assertEqual(snapshot["trace"], [{"t": 1, "mbps": 16}, {"t": 2.5, "mbps": 4}])
        self.now = 200
        self.assertEqual(self.dashboard.snapshot()["elapsed_s"], 4)
        snapshot["trace"][0]["mbps"] = 999
        self.assertEqual(self.dashboard.snapshot()["trace"][0]["mbps"], 16)

    def test_final_sample_without_progress_is_recorded_and_next_run_resets(self):
        def emit_samples(emit):
            self.now = 101
            emit({"type": "sample", "sample": self.sample(1, 2_000_000, 1)})

        self.run_measure(emit_samples)
        self.assertEqual(self.dashboard.snapshot()["trace"], [{"t": 1, "mbps": 16}])
        self.now = 110
        self.dashboard.start(speedometer.DEFAULT_URL)
        snapshot = self.dashboard.snapshot()
        self.assertEqual(snapshot["id"], 2)
        for key in ("elapsed_s", "current_bytes", "current_elapsed_s", "downloaded_bytes", "live_mbps"):
            self.assertEqual(snapshot[key], 0)
        self.assertEqual(snapshot["trace"], [])
        self.assertEqual(snapshot["samples"], [])
        self.now = 112
        self.assertEqual(self.dashboard.snapshot()["elapsed_s"], 2)

    def test_trace_is_bounded_and_has_monotonic_run_timestamps(self):
        def emit_samples(emit):
            for index in range(1, 261):
                self.now = 100 + index / 10
                data = self.sample(1, index * 10_000, index / 10)
                emit({"type": "progress", **data})
            emit({"type": "sample", "sample": data})

        self.run_measure(emit_samples)
        trace = self.dashboard.snapshot()["trace"]
        self.assertEqual(len(trace), 240)
        self.assertAlmostEqual(trace[0]["t"], 2.1)
        self.assertEqual(trace[-1]["t"], 26)
        self.assertTrue(all(a["t"] <= b["t"] for a, b in zip(trace, trace[1:])))
        for point in trace:
            self.assertAlmostEqual(point["mbps"], .8)

    def test_exception_freezes_elapsed_time(self):
        def fail(emit):
            self.now = 103
            raise RuntimeError("Unavailable")

        self.run_measure(fail)
        self.now = 110
        snapshot = self.dashboard.snapshot()
        self.assertEqual(snapshot["status"], "error")
        self.assertEqual(snapshot["error"], "Unavailable")
        self.assertEqual(snapshot["elapsed_s"], 3)


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

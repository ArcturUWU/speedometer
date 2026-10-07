"""Deterministic integration checks: every download comes from a local HTTP server."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import meter  # noqa: E402


PAYLOAD = bytes(range(256)) * 256


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), DownloadHandler)
        self.requests = []
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0


class DownloadHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_GET(self):
        with self.server.lock:
            self.server.requests.append(
                {"path": self.path, "headers": dict(self.headers.items())}
            )
            ordinal = len(self.server.requests)
            self.server.active += 1
            self.server.max_active = max(self.server.max_active, self.server.active)
        active = True
        try:
            path = urlsplit(self.path).path
            if path == "/slow":
                time.sleep(0.2)
            if path == "/alternating" and ordinal % 3 == 0:
                self.send_response(503)
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            length = len(PAYLOAD) + (19 if path == "/truncated" else 0)
            self.send_header("Content-Length", str(length))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.flush()
            if path == "/stall":
                time.sleep(0.2)
            self.wfile.write(PAYLOAD[:32768])
            self.wfile.flush()
            time.sleep(0.003)
            # Release before the last bytes: a correct client may start its next
            # request before this handler finishes its own teardown.
            with self.server.lock:
                self.server.active -= 1
            active = False
            self.wfile.write(PAYLOAD[32768:])
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            # The timeout / cancellation cases deliberately close their socket early.
            pass
        finally:
            self.close_connection = True
            if active:
                with self.server.lock:
                    self.server.active -= 1


class MeterTests(unittest.TestCase):
    def setUp(self):
        self.server = LocalServer()
        self.thread = threading.Thread(
            target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True
        )
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)

    def assert_statistics(self, result, successful, failed):
        stats = result["stats"]
        good_samples = [sample for sample in result["samples"] if not sample["error"]]
        self.assertEqual(stats["successful"], successful)
        self.assertEqual(stats["failed"], failed)
        self.assertEqual(len(good_samples), successful)
        self.assertEqual(stats["total_bytes"], sum(s["bytes"] for s in good_samples))
        self.assertAlmostEqual(
            stats["total_seconds"], sum(s["elapsed_s"] for s in good_samples), places=8
        )
        if successful:
            self.assertGreater(stats["total_seconds"], 0)
            self.assertAlmostEqual(
                stats["avg_seconds"], stats["total_seconds"] / successful, places=8
            )
            self.assertAlmostEqual(
                stats["MBps"], stats["total_bytes"] / stats["total_seconds"] / 1_000_000,
                places=6,
            )
            self.assertAlmostEqual(stats["mbps"], stats["MBps"] * 8, places=6)
            for sample in good_samples:
                self.assertAlmostEqual(
                    sample["MBps"], sample["bytes"] / sample["elapsed_s"] / 1_000_000,
                    places=6,
                )
                self.assertAlmostEqual(sample["mbps"], sample["MBps"] * 8, places=6)
        else:
            for field in ("total_bytes", "total_seconds", "avg_seconds", "mbps", "MBps"):
                self.assertEqual(stats[field], 0)

    def test_ten_sequential_downloads_and_exact_statistics(self):
        events = []
        url = self.base_url + "/payload?keep=hello%20world&blank=&repeat=1&repeat=2"
        result = meter.measure(url, on_event=events.append)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["url"], url)
        self.assertEqual(len(self.server.requests), 10)
        self.assertEqual(self.server.max_active, 1, "Downloads must be sequential")
        self.assertEqual([s["index"] for s in result["samples"]], list(range(1, 11)))
        self.assertEqual([s["bytes"] for s in result["samples"]], [len(PAYLOAD)] * 10)
        self.assert_statistics(result, successful=10, failed=0)
        progress = [event for event in events if event["type"] == "progress"]
        self.assertTrue(progress)
        self.assertEqual({event["index"] for event in progress}, set(range(1, 11)))
        self.assertTrue(all(event["elapsed_s"] >= 0 for event in progress))
        self.assertTrue(all(event["mbps"] >= 0 for event in progress))
        for index in range(1, 11):
            byte_counts = [event["bytes"] for event in progress if event["index"] == index]
            self.assertEqual(byte_counts, sorted(byte_counts))
            self.assertEqual(byte_counts[-1], len(PAYLOAD))
        self.assertEqual(len([e for e in events if e["type"] == "sample"]), 10)
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["result"], result)

        requested_urls = []
        for request in self.server.requests:
            query = parse_qs(urlsplit(request["path"]).query, keep_blank_values=True)
            self.assertEqual(query["keep"], ["hello world"])
            self.assertEqual(query["blank"], [""])
            self.assertEqual(query["repeat"], ["1", "2"])
            self.assertGreater(len(query), 3, "Each request should bypass shared caches")
            headers = {key.lower(): value for key, value in request["headers"].items()}
            self.assertEqual(headers["accept-encoding"], "identity")
            self.assertIn("no-cache", headers["cache-control"].lower())
            requested_urls.append(request["path"])
        self.assertEqual(len(set(requested_urls)), 10)

    def test_cache_busting_can_be_disabled_for_signed_urls(self):
        url = self.base_url + "/payload?signature=abc%2F123&empty="
        result = meter.measure(url, count=2, cache_bust=False)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(
            [request["path"] for request in self.server.requests],
            ["/payload?signature=abc%2F123&empty="] * 2,
        )
        self.assert_statistics(result, successful=2, failed=0)

    def test_http_failures_are_reported_and_excluded_from_average(self):
        result = meter.measure(self.base_url + "/alternating")
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["samples"]), 10)
        self.assertEqual(len(self.server.requests), 10)
        failures = [sample for sample in result["samples"] if sample["error"]]
        self.assertEqual([s["index"] for s in failures], [3, 6, 9])
        self.assertTrue(all("503" in s["error"] for s in failures))
        self.assertEqual(result["stats"]["total_bytes"], len(PAYLOAD) * 7)
        self.assert_statistics(result, successful=7, failed=3)

    def test_truncated_response_is_not_reported_as_success(self):
        result = meter.measure(self.base_url + "/truncated", count=1)
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["samples"][0]["error"])
        self.assert_statistics(result, successful=0, failed=1)

    def test_download_limit_stops_oversized_response(self):
        result = meter.measure(self.base_url + "/payload", count=1, max_bytes=1024)
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["samples"][0]["error"])
        self.assertLessEqual(result["samples"][0]["bytes"], 1024)
        self.assert_statistics(result, successful=0, failed=1)

    def test_timeout_covers_open_and_body_read(self):
        for path in ("/slow", "/stall"):
            with self.subTest(path=path):
                result = meter.measure(self.base_url + path, count=1, timeout=0.03)
                self.assertEqual(result["status"], "partial")
                self.assertTrue(result["samples"][0]["error"])
                self.assert_statistics(result, successful=0, failed=1)

    def test_already_cancelled_run_makes_no_network_requests(self):
        cancel = threading.Event()
        cancel.set()
        result = meter.measure(self.base_url + "/payload", cancel=cancel)
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["samples"], [])
        self.assertEqual(self.server.requests, [])
        self.assert_statistics(result, successful=0, failed=0)

    def test_cancellation_between_requests_preserves_completed_samples(self):
        cancel = threading.Event()

        def on_event(event):
            if event["type"] == "sample":
                cancel.set()

        result = meter.measure(self.base_url + "/payload", on_event=on_event, cancel=cancel)
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(len(result["samples"]), 1)
        self.assertEqual(len(self.server.requests), 1)
        self.assert_statistics(result, successful=1, failed=0)

    def test_unsupported_or_credentialed_urls_are_rejected_before_download(self):
        invalid = (
            "file:///etc/passwd", "ftp://example.com/file", "not-a-url",
            "http://", "http://user:secret@example.com/file", "https://user@example.com/",
        )
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(ValueError):
                meter.measure(url)
        self.assertEqual(self.server.requests, [])

    def run_cli(self, path):
        return subprocess.run(
            [sys.executable, str(ROOT / "meter.py"), self.base_url + path, "--json"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    def test_cli_outputs_machine_readable_result_for_ten_downloads(self):
        process = self.run_cli("/payload")
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(self.server.requests), 10)
        self.assert_statistics(result, successful=10, failed=0)

    def test_cli_returns_failure_exit_code_for_partial_measurement(self):
        process = self.run_cli("/alternating")
        self.assertNotEqual(process.returncode, 0)
        result = json.loads(process.stdout)
        self.assertEqual(result["status"], "partial")
        self.assert_statistics(result, successful=7, failed=3)


if __name__ == "__main__":
    unittest.main()

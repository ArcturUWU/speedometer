"""One-command local dashboard and console launcher. Python 3.10+, no dependencies."""

from __future__ import annotations

import argparse
import hmac
import json
import secrets
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from meter import DEFAULT_URL, measure, run_cli, validate_url

WEB = Path(__file__).resolve().parent / "web"


class Dashboard:
    def __init__(self):
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.token = secrets.token_urlsafe(32)
        self.started_at = None
        self.last_trace_sample = None
        self.state = self.ready()

    def ready(self):
        return {
            "id": 0, "status": "ready", "url": DEFAULT_URL,
            "index": 0, "live_mbps": 0, "samples": [], "error": None,
            "elapsed_s": 0, "current_bytes": 0, "current_elapsed_s": 0,
            "downloaded_bytes": 0, "trace": [],
            "stats": {"successful": 0, "failed": 0, "total_bytes": 0,
                      "total_seconds": 0, "avg_seconds": 0, "mbps": 0, "MBps": 0},
        }

    def snapshot(self):
        with self.lock:
            # Deep copy to avoid serializing a list while the worker changes it.
            result = json.loads(json.dumps(self.state))
            if result["status"] == "running":
                result["elapsed_s"] = self.elapsed()
            result["token"] = self.token
            return result

    def elapsed(self):
        return max(0.0, time.perf_counter() - self.started_at) if self.started_at is not None else 0.0

    def record_transfer(self, data):
        """Record measured payload only; setup callbacks are not zero-speed samples.

        Called under the state lock. The meter emits the last successful payload
        as both progress and sample, so that pair must produce just one point.
        """
        self.state["current_bytes"] = data["bytes"]
        self.state["current_elapsed_s"] = data["elapsed_s"]
        if data["bytes"] <= 0 or data["elapsed_s"] <= 0:
            return
        self.state["live_mbps"] = data["mbps"]
        key = (data["index"], data["bytes"], data["elapsed_s"], data["mbps"])
        if key == self.last_trace_sample:
            return
        trace = self.state["trace"]
        timestamp = self.elapsed()
        if trace:
            timestamp = max(trace[-1]["t"], timestamp)
        trace.append({"t": timestamp, "mbps": data["mbps"]})
        del trace[:-240]
        self.last_trace_sample = key

    def start(self, url):
        url = validate_url(url)
        with self.lock:
            if self.state["status"] == "running":
                raise RuntimeError("A test is already running. Cancel it first.")
            run_id = self.state["id"] + 1
            self.cancel = threading.Event()
            self.state = self.ready()
            self.state.update(id=run_id, status="running", url=url)
            self.started_at = time.perf_counter()
            self.last_trace_sample = None
        threading.Thread(target=self.worker, args=(url, run_id, self.cancel), daemon=True).start()

    def worker(self, url, run_id, cancel):
        print(f"\nM SPEEDOMETER | 10 sequential downloads\nTarget: {url}", flush=True)

        def event(data):
            with self.lock:
                if self.state["id"] != run_id:
                    return
                if data["type"] == "progress":
                    self.state["index"] = data["index"]
                    self.record_transfer(data)
                    self.state["downloaded_bytes"] = sum(s["bytes"] for s in self.state["samples"]) + data["bytes"]
                elif data["type"] == "sample":
                    sample = data["sample"]
                    self.record_transfer(sample)
                    self.state["samples"].append(sample)
                    self.state["index"] = sample["index"]
                    # Partial failed downloads still consumed network traffic.
                    self.state["downloaded_bytes"] = sum(s["bytes"] for s in self.state["samples"])
                    successful = [s for s in self.state["samples"] if s["error"] is None]
                    total_bytes = sum(s["bytes"] for s in successful)
                    total_seconds = sum(s["elapsed_s"] for s in successful)
                    mbps = total_bytes * 8 / 1_000_000 / total_seconds if total_seconds else 0
                    self.state["stats"] = {
                        "successful": len(successful),
                        "failed": len(self.state["samples"]) - len(successful),
                        "total_bytes": total_bytes, "total_seconds": total_seconds,
                        "avg_seconds": total_seconds / len(successful) if successful else 0,
                        "mbps": mbps, "MBps": mbps / 8,
                    }
                    detail = sample["error"] or f'{sample["bytes"] / 1_000_000:.2f} MB | {sample["elapsed_s"]:.3f} s | {sample["MBps"]:.2f} MB/s'
                    print(f'[{sample["index"]:02d}/10] {detail}', flush=True)

        try:
            result = measure(url, on_event=event, cancel=cancel)
            with self.lock:
                if self.state["id"] != run_id:
                    return
                self.state.update(result)
                self.state["live_mbps"] = result["stats"]["mbps"]
                self.state["elapsed_s"] = self.elapsed()
            stats = result["stats"]
            print(f'\n{result["status"].upper()} | {stats["successful"]}/10 successful | '
                  f'{stats["total_bytes"] / 1_000_000:.2f} MB | avg {stats["avg_seconds"]:.3f} s | '
                  f'{stats["MBps"]:.2f} MB/s ({stats["mbps"]:.2f} Mbps)\n', flush=True)
        except Exception as exc:
            with self.lock:
                if self.state["id"] == run_id:
                    self.state.update(status="error", error=str(exc), elapsed_s=self.elapsed())
            print(f"Test failed: {exc}", file=sys.stderr, flush=True)


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address):
        super().__init__(address, Handler)
        self.dashboard = Dashboard()


class Handler(BaseHTTPRequestHandler):
    server_version = "MSpeedometer/1.0"

    def log_message(self, *args):
        pass

    def respond(self, status, body, content_type="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def local_host(self):
        # Only this loopback address is accepted, including for read requests.
        return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

    def do_GET(self):
        if not self.local_host():
            self.respond(403, {"error": "Open the printed 127.0.0.1 address."})
            return
        route = urlsplit(self.path).path
        if route == "/api/status":
            self.respond(200, self.server.dashboard.snapshot())
            return
        files = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/index.html": ("index.html", "text/html; charset=utf-8"),
                 "/style.css": ("style.css", "text/css; charset=utf-8"),
                 "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                 "/favicon.svg": ("favicon.svg", "image/svg+xml"),
                 "/fonts/RobotoCondensed-Regular.woff2": ("fonts/RobotoCondensed-Regular.woff2", "font/woff2"),
                 "/fonts/RobotoCondensed-Cyrillic.woff2": ("fonts/RobotoCondensed-Cyrillic.woff2", "font/woff2")}
        if route not in files:
            self.respond(404, {"error": "Not found"})
            return
        filename, content_type = files[route]
        try:
            self.respond(200, (WEB / filename).read_bytes(), content_type)
        except FileNotFoundError:
            self.respond(404, {"error": f"Missing web/{filename}; extract the entire ZIP."})

    def do_POST(self):
        origin = self.headers.get("Origin")
        own_origin = f"http://127.0.0.1:{self.server.server_port}"
        supplied = self.headers.get("X-Speedometer-Token", "")
        if (not self.local_host() or (origin and origin != own_origin) or not supplied.isascii()
                or not hmac.compare_digest(supplied, self.server.dashboard.token)):
            self.respond(403, {"error": "Reload the local dashboard and try again."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192:
                raise ValueError("Invalid request body size.")
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise ValueError("Expected application/json.")
            self.connection.settimeout(5)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Expected a JSON object.")
            route = urlsplit(self.path).path
            if route == "/api/start":
                self.server.dashboard.start(body.get("url", ""))
            elif route == "/api/cancel":
                self.server.dashboard.cancel.set()
            else:
                self.respond(404, {"error": "Not found"})
                return
            self.respond(200, self.server.dashboard.snapshot())
        except RuntimeError as exc:
            self.respond(409, {"error": str(exc)})
        except (ValueError, TypeError, TimeoutError) as exc:
            self.respond(400, {"error": str(exc)})


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if "--cli" in args:
        args.remove("--cli")
        return run_cli(args)
    # A bare URL is also a convenient console invocation.
    if args and not args[0].startswith("-"):
        return run_cli(args)
    parser = argparse.ArgumentParser(description="M Speedometer: local dashboard. Use --cli [URL] for the console.")
    parser.add_argument("--port", type=int, default=8765, help="Local port; 0 chooses a free port.")
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser automatically.")
    options = parser.parse_args(args)
    if not 0 <= options.port <= 65535:
        parser.error("Port must be between 0 and 65535.")
    try:
        server = LocalServer(("127.0.0.1", options.port))
    except OSError as exc:
        print(f"Cannot open port {options.port}: {exc}\nTry: python speedometer.py --port 0", file=sys.stderr)
        return 1
    address = f"http://127.0.0.1:{server.server_port}"
    print(f"\nM SPEEDOMETER\nOpen: {address}\nStop server: Ctrl+C or close this window.\n", flush=True)
    if not options.no_browser:
        threading.Timer(0.3, lambda: webbrowser.open(address)).start()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.dashboard.cancel.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Measure HTTP download throughput with Python's standard library.

Every sample is a separate, sequential GET. Results describe the response body
received from the selected server, in decimal MB/s and megabits/s (Mbps).
"""

from __future__ import annotations

import argparse
import http.client
import json
import math
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable


DEFAULT_URL = "https://speed.cloudflare.com/__down?bytes=5000000"
CHUNK_SIZE = 64 * 1024
DEFAULT_MAX_BYTES = 100_000_000


class _Cancelled(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Handle redirects ourselves so each hop shares the original deadline."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_url(url: str) -> str:
    """Return a normalized HTTP(S) URL or raise ValueError.

    Credentials and control characters are rejected. Query parameters are kept;
    fragments are omitted because browsers do not send them to the server.
    """
    if not isinstance(url, str) or not url.strip():
        raise ValueError("Enter a complete http:// or https:// URL.")
    url = url.strip()
    if any(ord(char) <= 32 or ord(char) == 127 for char in url):
        raise ValueError("The URL must not contain spaces or control characters.")
    try:
        parts = urllib.parse.urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme not in {"http", "https"}:
            raise ValueError("Only http:// and https:// URLs are supported.")
        if parts.username is not None or parts.password is not None:
            raise ValueError("The URL must not include a username or password.")
        host = parts.hostname
        if not host:
            raise ValueError("The URL must include a hostname.")
        port = parts.port  # Also validates the numeric port and its range.
        host = host.encode("idna").decode("ascii").lower()
    except (UnicodeError, ValueError) as exc:
        raise ValueError(str(exc) or "Invalid URL.") from exc
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc += f":{port}"
    path = urllib.parse.quote(parts.path or "/", safe="/:@-._~!$&'()*+,;=%")
    query = urllib.parse.quote(parts.query, safe="/:?@-._~!$&'()*+,;=%")
    return urllib.parse.urlunsplit((scheme, netloc, path, query, ""))


def _is_cancelled(cancel) -> bool:
    if cancel is None:
        return False
    return bool(cancel.is_set() if hasattr(cancel, "is_set") else cancel())


def _remaining(deadline: float, cancel) -> float:
    if _is_cancelled(cancel):
        raise _Cancelled("Cancelled.")
    remaining = deadline - time.perf_counter()
    if remaining <= 0:
        raise TimeoutError("The request exceeded its time limit.")
    return remaining


def _request_url(url: str, cache_bust: bool) -> str:
    if not cache_bust:
        return url
    parts = urllib.parse.urlsplit(url)
    token = f"{time.time_ns()}-{secrets.token_hex(4)}"
    query = parts.query + ("&" if parts.query else "") + "_speedometer=" + token
    return urllib.parse.urlunsplit(parts._replace(query=query))


def _open_response(opener, url: str, deadline: float, cancel):
    """Open the final response, checking redirect destinations and deadlines."""
    for redirect_count in range(11):
        request = urllib.request.Request(
            url,
            headers={
                "Accept-Encoding": "identity",
                "Cache-Control": "no-cache, no-store",
                "Pragma": "no-cache",
                "User-Agent": "M-Speedometer/1.0",
            },
            method="GET",
        )
        try:
            return opener.open(request, timeout=_remaining(deadline, cancel))
        except urllib.error.HTTPError as exc:
            location = exc.headers.get("Location")
            if exc.code not in {301, 302, 303, 307, 308} or not location:
                exc.close()
                raise
            exc.close()
            if redirect_count == 10:
                raise ValueError("Too many redirects (maximum 10).") from exc
            url = validate_url(urllib.parse.urljoin(url, location))
    raise ValueError("Too many redirects.")  # Unreachable; useful to type checkers.


def _content_length(response) -> int | None:
    header = response.headers.get("Content-Length")
    if header is None:
        return None
    values = [value.strip() for value in header.split(",")]
    if not values or any(not value.isascii() or not value.isdecimal() for value in values):
        raise ValueError("Invalid Content-Length header.")
    lengths = [int(value) for value in values]
    if len(set(lengths)) != 1:
        raise ValueError("Conflicting Content-Length headers.")
    return lengths[0]


def _set_read_timeout(response, remaining: float) -> None:
    # urllib exposes an HTTPResponse; its buffered reader owns the actual socket.
    # read1 below performs one raw read, allowing the total deadline to be checked
    # between chunks even when a server sends the body very slowly.
    reader = getattr(response, "fp", None)
    raw = getattr(reader, "raw", reader)
    sock = getattr(raw, "_sock", None)
    if sock is not None:
        sock.settimeout(remaining)


def _rates(byte_count: int, elapsed: float) -> tuple[float, float]:
    MBps = byte_count / elapsed / 1_000_000 if elapsed > 0 else 0.0
    return MBps * 8, MBps


def _error_message(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code}: {exc.reason}"
    if isinstance(exc, urllib.error.URLError):
        return f"Connection failed: {exc.reason}"
    if isinstance(exc, TimeoutError):
        return "The request exceeded its time limit."
    return str(exc) or exc.__class__.__name__


def measure(
    url: str = DEFAULT_URL,
    on_event: Callable[[dict], None] | None = None,
    cancel=None,
    timeout: float = 15.0,
    count: int = 10,
    max_bytes: int = DEFAULT_MAX_BYTES,
    cache_bust: bool = True,
) -> dict:
    """Download ``count`` responses sequentially and return measured statistics.

    ``timeout`` bounds each complete request, including redirects and body reads.
    ``cancel`` accepts a threading.Event (or a callable cancellation predicate).
    Callbacks run synchronously and receive progress, sample, and done events.
    Failed/unfinished samples retain partial byte counts but do not enter stats.
    """
    url = validate_url(url)
    try:
        timeout = float(timeout)
    except (TypeError, ValueError) as exc:
        raise ValueError("Timeout must be a positive number of seconds.") from exc
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("Timeout must be a positive, finite number of seconds.")
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise ValueError("Request count must be a positive integer.")
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 1:
        raise ValueError("The response size limit must be a positive integer.")

    def emit(event):
        if on_event is not None:
            on_event(event)

    samples = []
    was_cancelled = False
    opener = urllib.request.build_opener(_NoRedirect())
    for index in range(1, count + 1):
        if _is_cancelled(cancel):
            was_cancelled = True
            break
        started = time.perf_counter()
        deadline = started + timeout
        byte_count = 0
        error = None
        response = None
        last_progress = started
        try:
            emit({"type": "progress", "index": index, "bytes": 0, "elapsed_s": 0.0, "mbps": 0.0})
            response = _open_response(opener, _request_url(url, cache_bust), deadline, cancel)
            _remaining(deadline, cancel)
            expected = _content_length(response)
            if expected is not None and expected > max_bytes:
                raise ValueError(f"Response exceeds the {max_bytes:,}-byte size limit.")
            # read1 avoids waiting for a whole buffer on a slow streaming body.
            reader = getattr(response, "read1", response.read)
            while True:
                _set_read_timeout(response, _remaining(deadline, cancel))
                chunk = reader(min(CHUNK_SIZE, max_bytes - byte_count + 1))
                _remaining(deadline, cancel)
                if not chunk:
                    break
                byte_count += len(chunk)
                if byte_count > max_bytes:
                    raise ValueError(f"Response exceeds the {max_bytes:,}-byte size limit.")
                now = time.perf_counter()
                if now - last_progress >= 0.08:
                    elapsed = now - started
                    mbps, _ = _rates(byte_count, elapsed)
                    emit({"type": "progress", "index": index, "bytes": byte_count, "elapsed_s": elapsed, "mbps": mbps})
                    last_progress = now
            if expected is not None and byte_count != expected:
                raise ValueError(f"Incomplete response: received {byte_count:,} of {expected:,} bytes.")
            if byte_count == 0:
                raise ValueError("The response body is empty; choose a download URL.")
        except (_Cancelled, KeyboardInterrupt):
            error = "Cancelled."
            was_cancelled = True
        except (OSError, ValueError, http.client.HTTPException) as exc:
            error = _error_message(exc)
            if _is_cancelled(cancel):
                error = "Cancelled."
                was_cancelled = True
        finally:
            if response is not None:
                response.close()
        elapsed = max(0.0, time.perf_counter() - started)
        mbps, MBps = _rates(byte_count, elapsed)
        sample = {"index": index, "bytes": byte_count, "elapsed_s": elapsed, "mbps": mbps, "MBps": MBps, "error": error}
        samples.append(sample)
        if error is None:
            emit({"type": "progress", "index": index, "bytes": byte_count, "elapsed_s": elapsed, "mbps": mbps})
        emit({"type": "sample", "sample": sample})
        if was_cancelled:
            break

    successful = [sample for sample in samples if sample["error"] is None]
    total_bytes = sum(sample["bytes"] for sample in successful)
    total_seconds = sum(sample["elapsed_s"] for sample in successful)
    mbps, MBps = _rates(total_bytes, total_seconds)
    status = "cancelled" if was_cancelled else "completed" if len(successful) == count else "partial"
    result = {
        "url": url,
        "status": status,
        "samples": samples,
        "stats": {
            "successful": len(successful),
            "failed": len(samples) - len(successful),
            "total_bytes": total_bytes,
            "total_seconds": total_seconds,
            "avg_seconds": total_seconds / len(successful) if successful else 0.0,
            "mbps": mbps,
            "MBps": MBps,
        },
    }
    emit({"type": "done", "result": result})
    return result


def run_cli(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Download a URL 10 times sequentially and measure internet throughput.",
        epilog="MB/s uses decimal megabytes; Mbps is megabits/s. Ctrl+C stops the test.",
    )
    parser.add_argument("url", nargs="?", default=DEFAULT_URL, help="HTTP(S) download URL (default: Cloudflare, 5 MB)")
    parser.add_argument("--timeout", type=float, default=15.0, metavar="SECONDS", help="Time limit per request (default: 15 seconds)")
    parser.add_argument("--json", action="store_true", help="Print only the complete JSON result")
    parser.add_argument("--no-cache-bust", action="store_true", help="Keep the URL query exactly as supplied (use for signed URLs)")
    parser.add_argument("--output", type=Path, metavar="FILE", help="Also save the complete result as JSON")
    args = parser.parse_args(argv)

    def print_sample(event):
        if event["type"] != "sample":
            return
        sample = event["sample"]
        if sample["error"]:
            print(f"[{sample['index']:2}/10] FAILED: {sample['error']}", flush=True)
        else:
            print(f"[{sample['index']:2}/10] {sample['bytes'] / 1_000_000:.2f} MB | {sample['elapsed_s']:.3f} s | {sample['MBps']:.2f} MB/s ({sample['mbps']:.2f} Mbps)", flush=True)

    try:
        result = measure(args.url, on_event=None if args.json else print_sample, timeout=args.timeout, cache_bust=not args.no_cache_bust)
    except ValueError as exc:
        parser.error(str(exc))
    except KeyboardInterrupt:
        print("Cancelled.", file=sys.stderr)
        return 1
    encoded = json.dumps(result, ensure_ascii=True, indent=2)
    if args.json:
        print(encoded)
    else:
        stats = result["stats"]
        print(f"\nResult: {result['status']} | successful {stats['successful']}/10 | failed {stats['failed']}")
        print(f"Downloaded: {stats['total_bytes'] / 1_000_000:.2f} MB | average request: {stats['avg_seconds']:.3f} s")
        print(f"Speed: {stats['MBps']:.2f} MB/s ({stats['mbps']:.2f} Mbps)")
    if args.output:
        try:
            args.output.write_text(encoded + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"Cannot save result: {exc}", file=sys.stderr)
            return 2
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(run_cli())

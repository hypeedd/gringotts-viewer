#!/usr/bin/env python3
"""
server.py — Read-only local web server for browsing an Obsidian vault.

Binds to 127.0.0.1 only. Serves a JSON API and the static frontend. Never writes
to the vault. Run:  python3 server.py   (or ./run.sh)

Environment:
  VAULT_PATH   path to the vault      (default: /home/jbarbosa/gringotts-vault)
  HOST         bind host              (default: 127.0.0.1)
  PORT         bind port              (default: 8765)
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from vault_index import VaultIndex

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"

VAULT_PATH = os.environ.get("VAULT_PATH", "/home/jbarbosa/gringotts-vault")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))

ASSET_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
    ".pdf", ".mp4", ".webm", ".mp3", ".ogg", ".wav",
}

mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")

index = VaultIndex(VAULT_PATH)


class Handler(BaseHTTPRequestHandler):
    server_version = "GringottsViewer/1.0"
    protocol_version = "HTTP/1.1"

    # ---- helpers ---------------------------------------------------------

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_bytes(self, data: bytes, content_type: str, status=200, cache=True):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=3600" if cache else "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _send_file(self, path: Path, cache=True):
        try:
            data = path.read_bytes()
        except OSError:
            self._send_json({"error": "not found"}, 404)
            return
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "text/javascript"):
            ctype += "; charset=utf-8" if "charset" not in ctype else ""
        self._send_bytes(data, ctype, cache=cache)

    def _error(self, status, msg):
        self._send_json({"error": msg}, status)

    # ---- routing ---------------------------------------------------------

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        qs = parse_qs(parsed.query)

        try:
            if path == "/" or path == "/index.html":
                self._send_file(STATIC / "index.html", cache=False)
                return
            if path.startswith("/api/"):
                self._handle_api(path, qs)
                return
            if path.startswith("/static/"):
                self._serve_static(path)
                return
            self._error(404, "not found")
        except BrokenPipeError:
            pass
        except Exception as exc:  # never leak a stack trace to the client
            self._error(500, f"internal error: {exc.__class__.__name__}")

    def _handle_api(self, path, qs):
        if path == "/api/index":
            index.refresh_if_stale()
            self._send_json(index.index_payload())
        elif path == "/api/note":
            rel = (qs.get("path") or [""])[0]
            index.refresh_if_stale()
            payload = index.note_payload(rel)
            if payload is None:
                self._error(404, "note not found")
            else:
                self._send_json(payload)
        elif path == "/api/search":
            q = (qs.get("q") or [""])[0]
            self._send_json({"query": q, "results": index.search(q)})
        elif path == "/api/asset":
            self._serve_asset((qs.get("path") or [""])[0])
        else:
            self._error(404, "unknown endpoint")

    def _serve_asset(self, rel):
        target = index.safe_path(rel)
        if target is None or not target.is_file() or target.suffix.lower() not in ASSET_EXT:
            self._error(404, "asset not found")
            return
        self._send_file(target)

    def _serve_static(self, path):
        # path like /static/js/app.js — confine to STATIC dir.
        rel = path[len("/static/"):]
        candidate = (STATIC / rel).resolve()
        try:
            candidate.relative_to(STATIC)
        except ValueError:
            self._error(403, "forbidden")
            return
        if not candidate.is_file():
            self._error(404, "not found")
            return
        # Vendored libs/fonts cache well; app code should not.
        cache = any(part in ("vendor", "fonts") for part in candidate.parts)
        self._send_file(candidate, cache=cache)

    def log_message(self, fmt, *args):
        # Quiet, single-line access log.
        sys.stderr.write(f"  {self.address_string()} {fmt % args}\n")


def main():
    if not Path(VAULT_PATH).is_dir():
        sys.exit(f"Vault not found: {VAULT_PATH}\nSet VAULT_PATH to your vault folder.")
    print("Indexing vault …", file=sys.stderr)
    index.ensure_loaded()
    n = len(index.notes)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}"
    print(f"\n  Gringotts Vault Viewer", file=sys.stderr)
    print(f"  Vault : {VAULT_PATH}  ({n} notes)", file=sys.stderr)
    print(f"  Open  : {url}\n", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.", file=sys.stderr)
        httpd.server_close()


if __name__ == "__main__":
    main()

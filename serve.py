#!/usr/bin/env python3
"""Serve remoteweb.user.js so Tampermonkey/Violentmonkey can auto-update it.

Every time the file is saved, the served @version changes (it ends with the
file's modification time), so the userscript manager sees a new version.
The @updateURL / @downloadURL lines are added automatically.

Usage:
    python3 serve.py            # http://127.0.0.1:8765/remoteweb.user.js
    python3 serve.py --lan      # also reachable from other machines on the network
    python3 serve.py --port 9000
"""

import argparse
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "remoteweb.user.js"
NAME = "/" + SCRIPT.name


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] != NAME:
            self.send_error(404, f"Only {NAME} is served here")
            return
        source = SCRIPT.read_text(encoding="utf-8")
        stamp = time.strftime("%Y%m%d%H%M%S", time.localtime(SCRIPT.stat().st_mtime))
        url = f"http://{self.headers.get('Host', 'localhost')}{NAME}"

        def patch_header(match):
            base = match.group(1)
            return (f"// @version      {base}.{stamp}\n"
                    f"// @updateURL    {url}\n"
                    f"// @downloadURL  {url}")

        # "0.2.0" -> "0.2.0.20261029153012"
        source, n = re.subn(r"^// @version\s+(\S+)$", patch_header, source, count=1, flags=re.M)
        if n == 0:
            self.send_error(500, "No @version line found in the script header")
            return
        body = source.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/javascript; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"{time.strftime('%H:%M:%S')}  {self.address_string()}  {fmt % args}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--lan", action="store_true", help="listen on all interfaces, not just localhost")
    args = parser.parse_args()
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    server = ThreadingHTTPServer((host, args.port), Handler)
    print(f"Serving {SCRIPT.name} at http://{'<this-machine-ip>' if args.lan else '127.0.0.1'}:{args.port}{NAME}")
    server.serve_forever()


if __name__ == "__main__":
    main()

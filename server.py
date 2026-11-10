#!/usr/bin/env python3
"""
Arena Touch - tiny relay server (Python 3.8+, standard library only).

Serves the tablet/phone control app and relays everything under /api/
(REST calls, clip thumbnails and the live WebSocket) to Resolume's own
web server, so the tablet only needs to reach ONE address on the show laptop.

Usage:
    python3 server.py                      # app on :8000, Resolume on 127.0.0.1:8080
    python3 server.py --port 9000 --resolume 127.0.0.1:8080

Then on the tablet open:  http://<show-laptop-ip>:8000
"""
import argparse
import asyncio
import mimetypes
import os
import socket
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parent / "web"
HOP_HEADERS = {"host", "origin", "referer"}


def local_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


async def read_head(reader):
    """Read an HTTP request head. Returns (request_line, [(name, value)]) or None."""
    try:
        raw = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
        return None
    lines = raw.decode("latin-1").split("\r\n")
    request_line = lines[0]
    headers = []
    for line in lines[1:]:
        if not line:
            continue
        name, _, value = line.partition(":")
        headers.append((name.strip(), value.strip()))
    return request_line, headers


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def relay(reader, writer, request_line, headers, target):
    """Forward one request (HTTP or WebSocket upgrade) to Resolume as a raw byte pipe."""
    host, port = target
    try:
        up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(host, port), 3)
    except (OSError, asyncio.TimeoutError):
        body = b'{"error":"Resolume web server not reachable. Is Arena running with the Webserver enabled (Preferences > Webserver)?"}'
        writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\n"
                     b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
        await writer.drain()
        writer.close()
        return

    is_upgrade = any(n.lower() == "upgrade" for n, _ in headers)
    out = [request_line, f"Host: {host}:{port}", f"Origin: http://{host}:{port}"]
    for name, value in headers:
        lname = name.lower()
        if lname in HOP_HEADERS:
            continue
        if lname == "connection" and not is_upgrade:
            continue
        out.append(f"{name}: {value}")
    if not is_upgrade:
        out.append("Connection: close")  # one request per upstream connection keeps the pipe simple
    up_writer.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1"))
    await up_writer.drain()

    await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))


EXTRA_TYPES = {".webm": "video/webm", ".mp4": "video/mp4", ".js": "text/javascript", ".css": "text/css"}


async def serve_static(writer, path, method, headers=()):
    rel = path.split("?", 1)[0].lstrip("/") or "index.html"
    file = (WEB_ROOT / rel).resolve()
    if WEB_ROOT not in file.parents or not file.is_file():
        file = None
    status = "200 OK"
    extra = ""
    if file is None:
        body = b"Not found"
        status = "404 Not Found"
        ctype = "text/plain"
    else:
        body = file.read_bytes()
        ctype = EXTRA_TYPES.get(file.suffix.lower()) or mimetypes.guess_type(str(file))[0] or "application/octet-stream"
        extra = "Accept-Ranges: bytes\r\n"
        # Range requests: iOS Safari won't play a video unless the server honours them.
        rng = next((v for n, v in headers if n.lower() == "range"), "")
        if rng.startswith("bytes="):
            start_s, _, end_s = rng[6:].split(",")[0].partition("-")
            try:
                size = len(body)
                if start_s:
                    start = int(start_s)
                    end = min(int(end_s), size - 1) if end_s else size - 1
                else:  # suffix range: last N bytes
                    start, end = max(0, size - int(end_s)), size - 1
                if start > end or start >= size:
                    raise ValueError
                body = body[start:end + 1]
                status = "206 Partial Content"
                extra += f"Content-Range: bytes {start}-{end}/{size}\r\n"
            except ValueError:
                status = "416 Range Not Satisfiable"
                extra = f"Content-Range: bytes */{len(body)}\r\n"
                body = b""
    head = (f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nCache-Control: no-cache\r\n{extra}"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n")
    writer.write(head.encode() + (b"" if method == "HEAD" else body))
    await writer.drain()
    writer.close()


def make_handler(target):
    async def handle(reader, writer):
        head = await read_head(reader)
        if head is None:
            writer.close()
            return
        request_line, headers = head
        try:
            method, path, _ = request_line.split(" ", 2)
        except ValueError:
            writer.close()
            return
        if path.startswith("/api/"):
            await relay(reader, writer, request_line, headers, target)
        else:
            await serve_static(writer, path, method, headers)
    return handle


async def main():
    ap = argparse.ArgumentParser(description="Arena Touch relay server")
    ap.add_argument("--port", type=int, default=8000, help="port the tablet connects to (default 8000)")
    ap.add_argument("--bind", default="0.0.0.0", help="interface to listen on (default all)")
    ap.add_argument("--resolume", default="127.0.0.1:8080",
                    help="Resolume webserver host:port (default 127.0.0.1:8080)")
    args = ap.parse_args()
    rhost, _, rport = args.resolume.rpartition(":")
    target = (rhost or "127.0.0.1", int(rport or 8080))

    server = await asyncio.start_server(make_handler(target), args.bind, args.port, limit=1 << 20)
    print(f"\n  Arena Touch is running. Relaying /api -> {target[0]}:{target[1]}")
    print(f"  On this laptop:   http://localhost:{args.port}")
    for ip in local_ips():
        print(f"  On tablet/phone:  http://{ip}:{args.port}")
    print("\n  Press Ctrl+C to stop.\n")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

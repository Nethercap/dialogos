#!/usr/bin/env python3
"""Dialogos: a branching dialogue editor in the browser, saving as you type into one JSON file.

    python dialogos.py [FILE] [--port N] [--no-browser]

FILE is the project to edit (created on the first run); dialogos.json in the current folder by
default. The page works without this server too (open web/index.html, or host the web folder):
then it keeps the project in the browser. With the server it writes straight to FILE, keeps
copies in .dialogos_backups next to it, and notices when something else changes the file.

Python's standard library only. MIT licence.
"""
import argparse
import datetime
import glob
import hashlib
import http.client
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
EXAMPLES = os.path.join(HERE, "examples")
APP = "dialogos"
PORT = 8377
# A copy of the file every so often while writing, and how many are kept.
BACKUP_EVERY = 300.0
BACKUPS_KEPT = 60
KINDS = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
	".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}
SAFE_NAME = re.compile(r"^[A-Za-z0-9_.-]+$")


def rev_of(raw: bytes) -> str:
	return hashlib.sha1(raw).hexdigest() if raw else ""


class Store:
	"""The project file: read, written whole and atomically, never over something it couldn't read."""

	def __init__(self, path: str):
		self.path = path
		self.backups = os.path.join(os.path.dirname(path), ".dialogos_backups")
		self.lock = threading.Lock()
		self.last_backup = 0.0

	def _raw(self) -> bytes:
		if not os.path.exists(self.path):
			return b""
		with open(self.path, "rb") as f:
			return f.read()

	def read(self):
		"""(revision, project or None when there's no file yet). Raises ValueError if it doesn't parse."""
		with self.lock:
			raw = self._raw()
			if not raw:
				return "", None
			return rev_of(raw), json.loads(raw.decode("utf-8-sig"))

	def revision(self) -> str:
		with self.lock:
			return rev_of(self._raw())

	def _write(self, raw: bytes) -> None:
		os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
		tmp = self.path + ".tmp"
		with open(tmp, "wb") as f:
			f.write(raw)
			f.flush()
			os.fsync(f.fileno())
		# (Windows refuses for a moment if something else has the file open)
		for attempt in range(8):
			try:
				os.replace(tmp, self.path)
				return
			except PermissionError:
				if attempt == 7:
					raise
				time.sleep(0.15)

	def _backup(self, old: bytes, force: bool) -> None:
		now = time.time()
		if not force and now - self.last_backup < BACKUP_EVERY:
			return
		os.makedirs(self.backups, exist_ok=True)
		stem = os.path.splitext(os.path.basename(self.path))[0]
		stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
		with open(os.path.join(self.backups, "%s_%s.json" % (stem, stamp)), "wb") as f:
			f.write(old)
		self.last_backup = now
		for stale in sorted(glob.glob(os.path.join(self.backups, stem + "_*.json")))[:-BACKUPS_KEPT]:
			os.remove(stale)

	def save(self, text: str, base_rev: str, force: bool = False):
		"""(ok, revision). Not ok when the file changed since `base_rev` (another tab, another program)."""
		doc = json.loads(text)
		if not isinstance(doc, dict) or not isinstance(doc.get("characters"), list) or not isinstance(doc.get("dialogues"), list):
			raise ValueError("not a Dialogos project (no characters or dialogues)")
		raw = text.encode("utf-8")
		with self.lock:
			old = self._raw()
			current = rev_of(old)
			if current and current != base_rev and not force:
				return False, current
			if raw == old:
				return True, current
			if old:
				try:
					fewer = len(json.loads(old.decode("utf-8-sig")).get("dialogues", [])) > len(doc["dialogues"])
				except (ValueError, AttributeError):
					fewer = True
				self._backup(old, fewer or force)
			self._write(raw)
			return True, rev_of(raw)


class Handler(BaseHTTPRequestHandler):
	store: Store = None
	port = PORT

	def log_message(self, fmt, *args):
		pass

	def _send(self, code: int, body: bytes, kind: str) -> None:
		self.send_response(code)
		self.send_header("Content-Type", kind)
		self.send_header("Content-Length", str(len(body)))
		self.send_header("Cache-Control", "no-store")
		self.send_header("X-Content-Type-Options", "nosniff")
		self.end_headers()
		self.wfile.write(body)

	def _send_json(self, code: int, value) -> None:
		self._send(code, json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

	def _send_file(self, folder: str, name: str) -> None:
		ext = os.path.splitext(name)[1].lower()
		path = os.path.join(folder, name)
		if not SAFE_NAME.match(name) or ext not in KINDS or not os.path.isfile(path):
			return self._send(404, b"", "text/plain")
		with open(path, "rb") as f:
			kind = KINDS[ext] + ("; charset=utf-8" if KINDS[ext].startswith(("text/", "application/json")) else "")
			self._send(200, f.read(), kind)

	def _local_host(self) -> bool:
		# (a page elsewhere can't reach this by a name that points here: DNS rebinding)
		return self.headers.get("Host", "") in ("127.0.0.1:%d" % self.port, "localhost:%d" % self.port)

	def do_GET(self):
		if not self._local_host():
			return self._send(403, b"", "text/plain")
		path = urllib.parse.urlsplit(self.path).path
		if path == "/api/ping":
			return self._send_json(200, {"app": APP, "file": self.store.path})
		if path == "/api/rev":
			return self._send_json(200, {"rev": self.store.revision()})
		if path == "/api/data":
			try:
				rev, doc = self.store.read()
			except ValueError as e:
				return self._send_json(500, {"error": "%s can't be read (%s). It was left as it is: fix it, or bring back a copy from %s." % (self.store.path, e, self.store.backups)})
			return self._send_json(200, {"rev": rev, "data": doc, "path": self.store.path})
		if path.startswith("/examples/"):
			return self._send_file(EXAMPLES, path[len("/examples/"):])
		return self._send_file(WEB, "index.html" if path == "/" else path.lstrip("/"))

	def do_POST(self):
		# (only this page writes: another site's form can't send JSON, or say it comes from here)
		origin = self.headers.get("Origin", "")
		if not self._local_host() or (origin and origin != "http://" + self.headers.get("Host", "")):
			return self._send(403, b"", "text/plain")
		if not self.headers.get("Content-Type", "").startswith("application/json"):
			return self._send(415, b"", "text/plain")
		if urllib.parse.urlsplit(self.path).path != "/api/data":
			return self._send(404, b"", "text/plain")
		try:
			body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode("utf-8"))
			ok, rev = self.store.save(body["text"], body.get("rev", ""), bool(body.get("force")))
		except (ValueError, KeyError, TypeError, AttributeError) as e:
			return self._send_json(400, {"error": str(e)})
		except OSError as e:
			return self._send_json(500, {"error": str(e)})
		self._send_json(200 if ok else 409, {"rev": rev})


def already_running(port: int, path: str) -> bool:
	try:
		c = http.client.HTTPConnection("127.0.0.1", port, timeout=1.0)
		c.request("GET", "/api/ping", headers={"Host": "127.0.0.1:%d" % port})
		info = json.loads(c.getresponse().read().decode("utf-8"))
		return info.get("app") == APP and os.path.normcase(info.get("file", "")) == os.path.normcase(path)
	except (OSError, ValueError):
		return False


def port_free(port: int) -> bool:
	with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
		# (Windows takes two seconds to say nobody's there; anyone here answers at once)
		s.settimeout(0.5)
		return s.connect_ex(("127.0.0.1", port)) != 0


def main() -> int:
	ap = argparse.ArgumentParser(description="Dialogos: a branching dialogue editor that saves to a JSON file.")
	ap.add_argument("file", nargs="?", default="dialogos.json", help="the project file (created if missing; dialogos.json by default)")
	ap.add_argument("--port", type=int, default=PORT, help="the first port to try (%d by default)" % PORT)
	ap.add_argument("--no-browser", action="store_true", help="don't open the page")
	args = ap.parse_args()
	path = os.path.abspath(args.file)
	sys.stdout.reconfigure(errors="replace")
	port = args.port
	for _ in range(20):
		if port_free(port):
			break
		if already_running(port, path):
			print("Already open: http://127.0.0.1:%d/" % port)
			if not args.no_browser:
				webbrowser.open("http://127.0.0.1:%d/" % port)
			return 0
		port += 1
	store = Store(path)
	try:
		store.read()
	except ValueError as e:
		print("%s can't be read (%s). Fix it or pick another file." % (path, e))
		return 1
	Handler.store = store
	Handler.port = port
	server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
	url = "http://127.0.0.1:%d/" % port
	print("Dialogos")
	print("  Page:  %s" % url)
	print("  File:  %s%s" % (path, "" if os.path.exists(path) else "  (new)"))
	print("Close this window (or Ctrl+C) to stop it. What you write is already saved.")
	sys.stdout.flush()
	if not args.no_browser:
		threading.Timer(0.3, webbrowser.open, (url,)).start()
	try:
		server.serve_forever()
	except KeyboardInterrupt:
		pass
	return 0


if __name__ == "__main__":
	sys.exit(main())

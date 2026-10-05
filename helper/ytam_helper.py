#!/usr/bin/env python3
"""YT -> Anki Miner audio helper.

A tiny local server for the browser extension. When you open a video it downloads
the audio track once with yt-dlp; when you save a card it cuts the exact piece of
audio with ffmpeg. Audio is therefore clean and does not depend on playback.

    GET /ping                                  -> {"ok": true, ...}
    GET /prepare?v=VIDEO_ID                    -> {"state": "ready"|"downloading"|"error", ...}
    GET /pcm?v=VIDEO_ID&start=S&end=E&rate=R   -> raw PCM, signed 16-bit little endian, mono

Requirements: Python 3.8+, `pip install -U yt-dlp imageio-ffmpeg` (start-helper.bat does it).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("YTAM_HOST", "127.0.0.1")
PORT = int(os.environ.get("YTAM_PORT", "8766"))
CACHE = os.environ.get("YTAM_CACHE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache"))
KEEP_FILES = int(os.environ.get("YTAM_KEEP", "40"))
ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,20}$")

os.makedirs(CACHE, exist_ok=True)
jobs = {}  # video id -> {"state", "progress", "error", "file", "event"}
jobs_lock = threading.Lock()


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


FFMPEG = find_ffmpeg()


def cached_file(vid):
    for name in os.listdir(CACHE):
        if name.startswith(vid + ".") and not name.endswith((".part", ".ytdl", ".tmp")):
            return os.path.join(CACHE, name)
    return None


def cleanup():
    files = [os.path.join(CACHE, f) for f in os.listdir(CACHE)]
    files = [f for f in files if os.path.isfile(f)]
    files.sort(key=os.path.getmtime, reverse=True)
    for f in files[KEEP_FILES:]:
        try:
            os.remove(f)
        except OSError:
            pass


def download(vid):
    job = jobs[vid]
    try:
        import yt_dlp

        def hook(d):
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                if total:
                    job["progress"] = round(d.get("downloaded_bytes", 0) / total, 3)

        opts = {
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": os.path.join(CACHE, "%(id)s.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "progress_hooks": [hook],
            "retries": 5,
            "fragment_retries": 5,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download(["https://www.youtube.com/watch?v=" + vid])
        path = cached_file(vid)
        if not path:
            raise RuntimeError("yt-dlp finished but no file was found")
        job.update(state="ready", file=path, progress=1)
        cleanup()
    except Exception as e:  # noqa: BLE001 - report everything to the extension
        job.update(state="error", error=str(e)[:500])
        print("[ytam] download failed for", vid, "-", e, file=sys.stderr)
    finally:
        job["event"].set()


def prepare(vid):
    with jobs_lock:
        job = jobs.get(vid)
        if job and job["state"] in ("ready", "downloading"):
            if job["state"] == "ready" and not os.path.exists(job.get("file") or ""):
                job = None
            else:
                return job
        path = cached_file(vid)
        if path:
            job = {"state": "ready", "progress": 1, "error": "", "file": path, "event": threading.Event()}
            job["event"].set()
            jobs[vid] = job
            os.utime(path)
            return job
        job = {"state": "downloading", "progress": 0, "error": "", "file": None, "event": threading.Event()}
        jobs[vid] = job
    threading.Thread(target=download, args=(vid,), daemon=True).start()
    return job


def cut_pcm(path, start, end, rate):
    start = max(0.0, start)
    dur = max(0.05, end - start)
    cmd = [FFMPEG, "-nostdin", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", path, "-t", f"{dur:.3f}",
           "-vn", "-ac", "1", "-ar", str(rate), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"]
    res = subprocess.run(cmd, capture_output=True, timeout=60)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.decode("utf-8", "replace")[:300] or "ffmpeg failed")
    return res.stdout


class Handler(BaseHTTPRequestHandler):
    server_version = "ytam-helper/1.0"

    def log_message(self, fmt, *args):  # quieter console
        pass

    def send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/ping":
                try:
                    import yt_dlp
                    ver = yt_dlp.version.__version__
                except Exception:
                    ver = None
                return self.send(200, {"ok": True, "ytdlp": ver, "ffmpeg": bool(FFMPEG), "cache": CACHE})

            vid = q.get("v", "")
            if not ID_RE.match(vid):
                return self.send(400, {"error": "bad video id"})

            if url.path == "/prepare":
                job = prepare(vid)
                return self.send(200, {"state": job["state"], "progress": job["progress"], "error": job["error"]})

            if url.path == "/pcm":
                if not FFMPEG:
                    return self.send(500, {"error": "ffmpeg not found: pip install imageio-ffmpeg"})
                job = prepare(vid)
                job["event"].wait(timeout=float(q.get("wait", 180)))
                if job["state"] != "ready":
                    return self.send(503, {"error": job["error"] or "audio is still downloading"})
                rate = min(48000, max(8000, int(float(q.get("rate", 24000)))))
                pcm = cut_pcm(job["file"], float(q["start"]), float(q["end"]), rate)
                return self.send(200, pcm, "application/octet-stream")

            return self.send(404, {"error": "unknown endpoint"})
        except Exception as e:  # noqa: BLE001
            return self.send(500, {"error": str(e)[:500]})


def main():
    print(f"[ytam] YT -> Anki audio helper on http://{HOST}:{PORT}")
    print(f"[ytam] cache: {CACHE}")
    print(f"[ytam] ffmpeg: {FFMPEG or 'NOT FOUND (pip install imageio-ffmpeg)'}")
    try:
        import yt_dlp
        print(f"[ytam] yt-dlp: {yt_dlp.version.__version__}")
    except Exception:
        print("[ytam] yt-dlp: NOT INSTALLED (pip install -U yt-dlp)")
    print("[ytam] Leave this window open while you watch YouTube. Ctrl+C to stop.")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

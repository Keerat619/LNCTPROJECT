#!/usr/bin/env python3
"""Local-first HTTP app. No cloud APIs or network calls are made by this app."""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import mimetypes
import os
import re
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

import cv2
import numpy as np

from engine import Detector, absolute_time, elapsed_label, process_detections, summarize
from store import DEFAULT_SETTINGS, Store, demo_session, new_id, new_session, now_iso

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
STORE: Store
DETECTOR: Detector
# Tracking rectangles live only in process memory; they are dropped on pause/restart.
RUNTIME: dict[str, dict] = {}


def safe_session(session: dict) -> dict:
    out = {k: v for k, v in session.items() if k not in ("samples", "roster")}
    out["last_sample"] = session["samples"][-1] if session["samples"] else None
    out.update(summarize(session))
    return out


def index_session(session: dict) -> dict:
    summary = summarize(session)
    return {k: session[k] for k in ("id", "name", "section", "source", "status", "created_at", "duration")} | {"stats": summary["stats"], "media_kind": session.get("media_kind")}


def text(value, field, limit=120, required=False):
    if not isinstance(value, str):
        raise ValueError(f"{field} must be text")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{field} is required")
    if len(value) > limit or any(ord(c) < 32 and c not in "\n\t" for c in value):
        raise ValueError(f"{field} is too long or contains invalid characters")
    return value


def validated_settings(source: dict, current: dict | None = None) -> dict:
    result = dict(current or DEFAULT_SETTINGS)
    if "presence_threshold" in source:
        value = source["presence_threshold"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 2 <= value <= 600:
            raise ValueError("Presence threshold must be between 2 and 600 seconds")
        result["presence_threshold"] = int(value)
    if "sample_interval" in source:
        value = source["sample_interval"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 1 <= value <= 10:
            raise ValueError("Sample interval must be between 1 and 10 seconds")
        result["sample_interval"] = int(value)
    if "audio_threshold" in source:
        value = source["audio_threshold"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0.001 <= value <= 0.5:
            raise ValueError("Audio threshold must be between 0.001 and 0.5")
        result["audio_threshold"] = round(float(value), 3)
    if "detector" in source:
        if source["detector"] not in ("face", "body"):
            raise ValueError("Detector must be face or body")
        result["detector"] = source["detector"]
    return result


def csv_safe(value) -> str:
    value = str(value if value is not None else "")
    # Prevent formula injection if a spreadsheet opens a user-entered name/code.
    if value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return value


def attendance_csv(session: dict) -> bytes:
    summary = summarize(session)
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["Session", "Session start", "Learner", "Learner ID", "Anonymous track", "Attendance",
                     "Status source", "First observed (elapsed)", "Last observed (elapsed)",
                     "First observed (session-relative timestamp)", "Last observed (session-relative timestamp)", "Observed seconds"])
    for row in summary["roster_rows"]:
        track = row.get("track")
        writer.writerow([csv_safe(session["name"]), session["created_at"], csv_safe(row["name"]), csv_safe(row.get("code", "")),
            row.get("track_id") or "", row["status"], row["status_source"],
            elapsed_label(track["first_seen"]) if track else "", elapsed_label(track["last_seen"]) if track else "",
            absolute_time(session["created_at"], track["first_seen"]) if track else "",
            absolute_time(session["created_at"], track["last_seen"]) if track else "",
            round(track["seen_seconds"], 1) if track else ""])
    for track in summary["unmapped_tracks"]:
        writer.writerow([csv_safe(session["name"]), session["created_at"], "", "", track["id"],
                         "present" if track["qualified"] else "unmarked", "anonymous track",
                         elapsed_label(track["first_seen"]), elapsed_label(track["last_seen"]),
                         absolute_time(session["created_at"], track["first_seen"]),
                         absolute_time(session["created_at"], track["last_seen"]), round(track["seen_seconds"], 1)])
    return ("\ufeff" + stream.getvalue()).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "ClassroomLens/1.0"

    def log_message(self, fmt, *args):
        # Never print request bodies; audio level headers and image bytes are not logged.
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def common_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'")

    def respond(self, status: int, body: bytes, content_type: str, extra: dict | None = None):
        self.send_response(status)
        self.common_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if extra:
            for k, v in extra.items(): self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def js(self, data, status=200):
        self.respond(status, json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8"),
                     "application/json; charset=utf-8", {"Cache-Control": "no-store"})

    def error_json(self, status, message):
        self.js({"error": message}, status)

    def read_bytes(self, limit):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid content length")
        if length < 0 or length > limit:
            raise ValueError("Request is too large")
        return self.rfile.read(length)

    def read_json(self):
        try:
            obj = json.loads(self.read_bytes(100_000) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("Invalid JSON")
        if not isinstance(obj, dict):
            raise ValueError("Expected a JSON object")
        return obj

    def get_session(self, sid):
        session = STORE.session(sid)
        if session is None:
            raise LookupError("Session not found")
        return session

    def serve_static(self, path):
        if path == "/":
            target = STATIC / "index.html"
        elif path.startswith("/static/"):
            target = (STATIC / unquote(path[len("/static/"):])).resolve()
            try: target.relative_to(STATIC.resolve())
            except ValueError: return self.error_json(403, "Forbidden")
        else:
            return self.error_json(404, "Not found")
        if not target.is_file():
            return self.error_json(404, "File not found")
        mime = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".js": mime = "text/javascript"
        if target.suffix == ".woff2": mime = "font/woff2"
        return self.respond(200, target.read_bytes(), mime, {"Cache-Control": "no-cache"})

    def do_HEAD(self):
        return self.do_GET()

    def do_GET(self):
        path = urlsplit(self.path).path
        try:
            if not path.startswith("/api/"):
                return self.serve_static(path)
            with STORE.lock:
                if path == "/api/bootstrap":
                    return self.js({"settings": STORE.data["settings"],
                                    "sessions": [index_session(s) for s in STORE.data["sessions"]],
                                    "version": "1.0", "opencv": cv2.__version__})
                match = re.fullmatch(r"/api/sessions/([a-zA-Z0-9-]+)(/export\.csv)?", path)
                if match:
                    session = self.get_session(match.group(1))
                    if match.group(2):
                        return self.respond(200, attendance_csv(session), "text/csv; charset=utf-8",
                            {"Content-Disposition": 'attachment; filename="attendance-export.csv"', "Cache-Control": "no-store"})
                    return self.js(safe_session(session))
            return self.error_json(404, "Not found")
        except LookupError as e:
            return self.error_json(404, str(e))
        except (ValueError, TypeError) as e:
            return self.error_json(400, str(e))
        except Exception as e:
            print(f"GET error: {e}", file=sys.stderr)
            return self.error_json(500, "The local server could not complete this request")

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            frame_match = re.fullmatch(r"/api/sessions/([a-zA-Z0-9-]+)/frame", path)
            if frame_match:
                # Bound memory usage; browser sends one reduced JPEG at a time.
                raw = self.read_bytes(2_000_000)
                try:
                    elapsed = float(self.headers.get("X-Elapsed", "nan"))
                    rms_header = self.headers.get("X-Audio-RMS", "")
                    rms = float(rms_header) if rms_header else None
                except ValueError:
                    raise ValueError("Invalid sample time or audio level")
                if not math.isfinite(elapsed) or not 0 <= elapsed <= 172800:
                    raise ValueError("Invalid sample time")
                if rms is not None and (not math.isfinite(rms) or not 0 <= rms <= 1):
                    raise ValueError("Invalid audio level")
                image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
                if image is None or image.shape[0] * image.shape[1] > 4_000_000:
                    raise ValueError("Could not decode the frame or dimensions are too large")
                with STORE.lock:
                    session = self.get_session(frame_match.group(1))
                    if session["status"] != "open":
                        raise ValueError("Only open sessions can receive frames")
                    if len(session["samples"]) >= 50_000:
                        raise ValueError("Session sample limit reached")
                    detections = DETECTOR.detect(image, session["detector"])
                    sample = process_detections(session, RUNTIME.setdefault(session["id"], {}), detections, elapsed, rms)
                    STORE.save()
                    summary = summarize(session)
                    return self.js({"sample": sample, "detections": detections,
                                    "stats": summary["stats"], "suggestions": summary["suggestions"],
                                    "tracks": session["tracks"]})
            data = self.read_json()
            with STORE.lock:
                if path == "/api/sessions":
                    name = text(data.get("name", ""), "Session name", 100, True)
                    section = text(data.get("section", ""), "Section", 100)
                    source = data.get("source", "camera")
                    if source not in ("camera", "video"):
                        raise ValueError("Choose camera or video")
                    if data.get("consent") is not True:
                        raise ValueError("Confirm you have permission to process the session")
                    roster = data.get("roster", [])
                    if not isinstance(roster, list) or len(roster) > 500:
                        raise ValueError("Roster must have at most 500 names")
                    roster = [text(n, "Learner name", 100, True) for n in roster]
                    settings = validated_settings(data.get("settings", {}), STORE.data["settings"])
                    session = new_session(name, section, source, settings, roster)
                    STORE.data["sessions"].insert(0, session)
                    STORE.save()
                    return self.js(safe_session(session), 201)
                if path == "/api/demo/restore":
                    STORE.data["sessions"] = [s for s in STORE.data["sessions"] if s["id"] != "demo-session"]
                    demo = demo_session()
                    STORE.data["sessions"].append(demo)
                    RUNTIME.pop("demo-session", None)
                    STORE.save()
                    return self.js(safe_session(demo))
                match = re.fullmatch(r"/api/sessions/([a-zA-Z0-9-]+)/(roster|pause|close)", path)
                if match:
                    session = self.get_session(match.group(1))
                    action = match.group(2)
                    duration = None
                    if action in ("pause", "close") and "duration" in data:
                        duration = data["duration"]
                        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 <= duration <= 172800:
                            raise ValueError("Invalid session duration")
                    if action == "roster":
                        if len(session["roster"]) >= 500: raise ValueError("Roster limit reached")
                        name = text(data.get("name", ""), "Learner name", 100, True)
                        code = text(data.get("code", ""), "Learner ID", 80)
                        row = {"id": new_id("learner"), "name": name, "code": code,
                               "track_id": None, "manual_status": "auto"}
                        session["roster"].append(row)
                    elif action == "pause":
                        media_kind = data.get("media_kind")
                        if media_kind is not None:
                            if media_kind not in ("synthetic", "user") or (media_kind == "synthetic" and session["source"] != "video"):
                                raise ValueError("Invalid capture source")
                            previous = session.get("media_kind")
                            if session["samples"] and previous and previous != media_kind:
                                raise ValueError("Create a new session to switch between synthetic and real footage")
                            session["media_kind"] = media_kind
                        RUNTIME.pop(session["id"], None)
                    else:
                        session["status"] = "completed"
                        session["ended_at"] = now_iso()
                        RUNTIME.pop(session["id"], None)
                    if duration is not None:
                        session["duration"] = max(float(session.get("duration", 0)), round(float(duration), 2))
                    STORE.save()
                    return self.js(safe_session(session))
            return self.error_json(404, "Not found")
        except LookupError as e:
            return self.error_json(404, str(e))
        except (ValueError, TypeError) as e:
            return self.error_json(400, str(e))
        except Exception as e:
            print(f"POST error: {e}", file=sys.stderr)
            return self.error_json(500, "The local server could not complete this request")

    def do_PATCH(self):
        path = urlsplit(self.path).path
        try:
            data = self.read_json()
            with STORE.lock:
                if path == "/api/settings":
                    STORE.data["settings"] = validated_settings(data, STORE.data["settings"])
                    STORE.save()
                    return self.js(STORE.data["settings"])
                match = re.fullmatch(r"/api/sessions/([a-zA-Z0-9-]+)/roster/([a-zA-Z0-9-]+)", path)
                if match:
                    session = self.get_session(match.group(1))
                    row = next((r for r in session["roster"] if r["id"] == match.group(2)), None)
                    if not row: raise LookupError("Learner not found")
                    updated = dict(row)
                    if "name" in data: updated["name"] = text(data["name"], "Learner name", 100, True)
                    if "code" in data: updated["code"] = text(data["code"], "Learner ID", 80)
                    if "manual_status" in data:
                        if data["manual_status"] not in ("auto", "present", "absent", "unmarked"):
                            raise ValueError("Invalid attendance status")
                        updated["manual_status"] = data["manual_status"]
                    if "track_id" in data:
                        tid = data["track_id"] or None
                        if tid and not any(t["id"] == tid for t in session["tracks"]):
                            raise ValueError("Track not found in this session")
                        if tid and any(r["id"] != row["id"] and r.get("track_id") == tid for r in session["roster"]):
                            raise ValueError("That track is already matched to another learner")
                        updated["track_id"] = tid
                    row.update(updated)
                    STORE.save()
                    return self.js(safe_session(session))
            return self.error_json(404, "Not found")
        except LookupError as e:
            return self.error_json(404, str(e))
        except (ValueError, TypeError) as e:
            return self.error_json(400, str(e))
        except Exception as e:
            print(f"PATCH error: {e}", file=sys.stderr)
            return self.error_json(500, "The local server could not complete this request")

    def do_DELETE(self):
        path = urlsplit(self.path).path
        try:
            with STORE.lock:
                match = re.fullmatch(r"/api/sessions/([a-zA-Z0-9-]+)(?:/roster/([a-zA-Z0-9-]+))?", path)
                if not match: return self.error_json(404, "Not found")
                session = self.get_session(match.group(1))
                rid = match.group(2)
                if rid:
                    row = next((r for r in session["roster"] if r["id"] == rid), None)
                    if not row: raise LookupError("Learner not found")
                    session["roster"].remove(row)
                    STORE.save()
                    return self.js(safe_session(session))
                STORE.data["sessions"].remove(session)
                RUNTIME.pop(session["id"], None)
                STORE.save()
                return self.js({"ok": True})
        except LookupError as e:
            return self.error_json(404, str(e))
        except Exception as e:
            print(f"DELETE error: {e}", file=sys.stderr)
            return self.error_json(500, "The local server could not complete this request")


def main():
    parser = argparse.ArgumentParser(description="Local-first attendance & engagement prototype")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1 for local privacy)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--data-dir", default=os.environ.get("ATTENDANCE_DATA_DIR", str(ROOT / "data")))
    args = parser.parse_args()
    global STORE, DETECTOR
    STORE = Store(args.data_dir)
    DETECTOR = Detector()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Classroom Lens running at http://{args.host}:{args.port}", flush=True)
    print(f"Data stored at {STORE.file}; raw frames/audio are not saved.", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()

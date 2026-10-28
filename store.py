"""Small local JSON store and fictional, clearly labelled starter session."""
from __future__ import annotations
import json
import os
import random
import threading
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from engine import activity_score

DEFAULT_SETTINGS = {"presence_threshold": 10, "sample_interval": 2,
                    "detector": "face", "audio_threshold": 0.02}


def new_id(prefix: str) -> str:
    return prefix + "-" + uuid4().hex[:10]


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_session(name: str, section: str, source: str, settings: dict, roster_names: list[str]) -> dict:
    return {"id": new_id("session"), "name": name, "section": section, "source": source,
            "media_kind": None, "status": "open", "created_at": now_iso(), "ended_at": None,
            "presence_threshold": settings["presence_threshold"], "sample_interval": settings["sample_interval"],
            "detector": settings["detector"], "audio_threshold": settings["audio_threshold"],
            "duration": 0, "next_track": 1, "roster": [
                {"id": new_id("learner"), "name": n, "code": "", "track_id": None, "manual_status": "auto"}
                for n in roster_names], "tracks": [], "samples": [], "events": []}


def demo_session() -> dict:
    """All people, observations, and teaching suggestions here are simulated."""
    names = ["Maya Patel", "Ethan Williams", "Aarav Sharma", "Sofia Martinez", "Noah Kim",
             "Aisha Johnson", "Oliver Chen", "Zara Ahmed", "Lucas Brown", "Isha Verma",
             "Mia Thompson", "Aditya Rao", "Amelia Davis", "Daniel Lee", "Priya Nair",
             "James Wilson", "Leila Hassan", "Arjun Mehta", "Chloe Martin", "Rohan Gupta",
             "Ella Garcia", "Samira Ali", "Leo Nguyen", "Anika Singh", "Harper Jones",
             "Kabir Desai", "Lily Walker", "Vihaan Kapoor"]
    start = datetime.now().astimezone().replace(hour=9, minute=0, second=0, microsecond=0)
    session = new_session("Foundations of Data Science", "Section A · Sample session", "demo", DEFAULT_SETTINGS, [])
    session.update({"id": "demo-session", "status": "demo", "created_at": start.isoformat(),
                    "ended_at": None, "duration": 2820, "next_track": 25})
    for i, name in enumerate(names):
        track_id = f"P-{i + 1:03d}" if i < 24 else None
        session["roster"].append({"id": f"demo-learner-{i+1:03d}", "name": name,
                                  "code": f"ST-{i+1:03d}", "track_id": track_id,
                                  "manual_status": "auto"})
        if track_id:
            first = 6 + (i * 7) % 85
            last = 2760 - (i * 11) % 100
            seen = max(10, last - first - (i * 17) % 250)
            session["tracks"].append({"id": track_id, "first_seen": first, "last_seen": last,
                                      "seen_seconds": seen, "last_moved": last - 9,
                                      "qualified": True})
            session["events"].extend([
                {"t": first, "type": "detected", "track_id": track_id, "text": f"{track_id} first detected"},
                {"t": first + 10, "type": "qualified", "track_id": track_id,
                 "text": f"{track_id} reached the 10s presence threshold"}])
    session["events"].sort(key=lambda e: e["t"])
    movements = [0.64, 0.70, 0.78, 0.66, 0.52, 0.38, 0.61, 0.73, 0.79, 0.72]
    audio_counts = [5, 6, 6, 5, 3, 2, 5, 6, 7, 6]
    rng = random.Random(104)
    for bucket in range(10):
        for k in range(10):
            t = bucket * 300 + k * 30
            if t > session["duration"]:
                break
            move = round(max(0, min(1, movements[bucket] + rng.uniform(-0.045, 0.045))), 3)
            audio_active = ((k * 7 + bucket) % 10) < audio_counts[bucket]
            session["samples"].append({"t": t, "visible": 23 + (k % 3 == 0), "motion": move,
                "audio_rms": 0.041 if audio_active else 0.009, "audio_active": audio_active,
                "activity": activity_score(move, audio_active),
                "face_tilt": round(-1.2 + rng.uniform(-1.5, 1.5), 1), "tilt_count": 6,
                "max_still": 30 + (k * 3) % 25})
    return session


class Store:
    def __init__(self, data_dir: str | Path):
        self.path = Path(data_dir)
        self.path.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.file = self.path / "sessions.json"
        self.lock = threading.RLock()
        if self.file.exists():
            with self.file.open("r", encoding="utf-8") as f:
                self.data = json.load(f)
            if not isinstance(self.data, dict) or not isinstance(self.data.get("sessions"), list):
                raise RuntimeError(f"Invalid data file: {self.file}. Back it up before repairing it.")
            self.data.setdefault("settings", dict(DEFAULT_SETTINGS))
        else:
            self.data = {"version": 1, "settings": dict(DEFAULT_SETTINGS), "sessions": [demo_session()]}
            self.save()

    def save(self) -> None:
        # Write atomically; no frames, audio recordings, face embeddings, or video files.
        tmp = self.file.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, separators=(",", ":"))
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.file)

    def session(self, sid: str) -> dict | None:
        return next((s for s in self.data["sessions"] if s["id"] == sid), None)

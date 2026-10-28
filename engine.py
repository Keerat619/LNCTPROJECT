"""Offline, deliberately simple attendance and group-activity processing.

The detectors are classical OpenCV models, not identity recognition. The tracker
is a nearest-centre heuristic. All metrics are observable proxies, never proof of
attention, learning, intent, or speaker identity.
"""
from __future__ import annotations

import math
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any

import cv2
import numpy as np


class Detector:
    def __init__(self) -> None:
        self.faces = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        self.eyes = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye.xml")
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        if self.faces.empty() or self.eyes.empty():
            raise RuntimeError("OpenCV's bundled Haar cascade files are unavailable")

    def detect(self, frame: np.ndarray, mode: str) -> list[dict[str, Any]]:
        # Normalize dimensions before detection and before matching across frames.
        h, w = frame.shape[:2]
        if w > 640:
            frame = cv2.resize(frame, (640, max(1, round(h * 640 / w))))
        h, w = frame.shape[:2]
        if mode == "body":
            if h < 128 or w < 64:
                return []
            rects, scores = self.hog.detectMultiScale(frame, winStride=(8, 8), padding=(8, 8), scale=1.06)
            if len(rects) == 0:
                return []
            # HOG can emit overlapping boxes for one person. Suppress duplicates.
            boxes = [list(map(int, r)) for r in rects]
            weights = [float(s) for s in scores]
            indices = cv2.dnn.NMSBoxes(boxes, weights, 0.0, 0.35)
            keep = np.asarray(indices).flatten().tolist() if len(indices) else []
            return [self._box(boxes[i], w, h, None) for i in keep]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        rects = self.faces.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        result = []
        for x, y, fw, fh in rects:
            # Two eye centers yield only a rough 2D roll angle, not gaze, yaw, or attention.
            tilt = self._eye_tilt(gray[y:y + int(fh * 0.7), x:x + fw], int(fw), int(fh))
            result.append(self._box([int(x), int(y), int(fw), int(fh)], w, h, tilt))
        return result

    @staticmethod
    def _box(rect: list[int], w: int, h: int, tilt: float | None) -> dict[str, Any]:
        x, y, bw, bh = rect
        return {"box": [x / w, y / h, bw / w, bh / h], "tilt": tilt}

    def _eye_tilt(self, roi: np.ndarray, fw: int, fh: int) -> float | None:
        if roi.size == 0 or fw < 48 or fh < 48:
            return None
        eyes = self.eyes.detectMultiScale(roi, scaleFactor=1.1, minNeighbors=5, minSize=(max(10, fw // 9), max(10, fh // 9)))
        centers = [(ex + ew / 2, ey + eh / 2) for ex, ey, ew, eh in eyes]
        pairs = []
        for i, a in enumerate(centers):
            for b in centers[i + 1:]:
                left, right = sorted([a, b], key=lambda p: p[0])
                dx, dy = right[0] - left[0], right[1] - left[1]
                if fw * 0.22 <= dx <= fw * 0.78 and abs(dy) <= fh * 0.22:
                    pairs.append((dx, math.degrees(math.atan2(dy, dx))))
        if not pairs:
            return None
        return round(max(pairs, key=lambda p: p[0])[1], 1)


def activity_score(motion: float | None, audio_active: bool | None) -> float | None:
    """65% moving tracks + 35% sound-active samples; normalize missing inputs.

    This is an illustrative, unvalidated signal, not an engagement prediction.
    """
    values: list[tuple[float, float]] = []
    if motion is not None:
        values.append((0.65, min(1.0, max(0.0, float(motion)))))
    if audio_active is not None:
        values.append((0.35, 1.0 if audio_active else 0.0))
    if not values:
        return None
    return round(100 * sum(w * v for w, v in values) / sum(w for w, _ in values), 1)


def _center(box: list[float]) -> tuple[float, float]:
    return box[0] + box[2] / 2, box[1] + box[3] / 2


def process_detections(session: dict, runtime: dict, detections: list[dict], elapsed: float,
                       audio_rms: float | None) -> dict:
    """Update session using supplied detections; image pixels are never persisted.

    `runtime` contains ephemeral boxes only, and is discarded on pause/restart.
    Elapsed times are session-relative (video playback time for a video).
    """
    elapsed = round(float(elapsed), 2)
    if session["samples"] and elapsed <= session["samples"][-1]["t"]:
        raise ValueError("Frames must have increasing timestamps")
    interval = float(session.get("sample_interval", 2))
    threshold = float(session.get("presence_threshold", 10))
    tolerance = max(6.0, interval * 3.2)
    active = runtime.setdefault("active", {})
    for tid in list(active):
        if elapsed - active[tid]["last_t"] > tolerance:
            del active[tid]
    tracks = {tr["id"]: tr for tr in session["tracks"]}

    # Greedy nearest-centre association; no appearance model or face recognition.
    candidates = []
    for di, detection in enumerate(detections):
        cx, cy = _center(detection["box"])
        for tid, prev in active.items():
            px, py = _center(prev["box"])
            d = math.hypot(cx - px, cy - py)
            max_dist = max(0.055, min(0.20, 1.4 * max(prev["box"][2], prev["box"][3])))
            if d <= max_dist:
                candidates.append((d, di, tid))
    candidates.sort()
    matches: dict[int, tuple[str, float]] = {}
    used_tracks: set[str] = set()
    for distance, di, tid in candidates:
        if di not in matches and tid not in used_tracks:
            matches[di] = (tid, distance)
            used_tracks.add(tid)

    moving, measured, max_still = 0, 0, 0.0
    for di, det in enumerate(detections):
        if di in matches:
            tid, distance = matches[di]
            track = tracks[tid]
            gap = elapsed - track["last_seen"]
            # Large unobserved gaps cannot contribute unlimited attendance time.
            track["seen_seconds"] = round(track["seen_seconds"] + min(max(0, gap), interval * 1.5), 1)
            track["last_seen"] = elapsed
            measured += 1
            # 0.8% of the frame diagonal; camera motion can still look like movement.
            if distance >= 0.008:
                moving += 1
                track["last_moved"] = elapsed
            still = max(0.0, elapsed - track.get("last_moved", elapsed))
            max_still = max(max_still, still)
            if not track.get("qualified") and track["seen_seconds"] >= threshold:
                track["qualified"] = True
                session["events"].append({"t": elapsed, "type": "qualified", "track_id": tid,
                                          "text": f"{tid} reached the {int(threshold)}s presence threshold"})
        else:
            n = int(session.get("next_track", 1))
            tid = f"P-{n:03d}"
            session["next_track"] = n + 1
            track = {"id": tid, "first_seen": elapsed, "last_seen": elapsed,
                     "seen_seconds": 0.0, "last_moved": elapsed, "qualified": False}
            session["tracks"].append(track)
            tracks[tid] = track
            session["events"].append({"t": elapsed, "type": "detected", "track_id": tid,
                                      "text": f"{tid} first detected"})
        active[tid] = {"box": det["box"], "last_t": elapsed}
        # Returned to the current browser only; boxes and pixels are not persisted.
        det["track_id"] = tid

    motion = round(moving / measured, 3) if measured else None
    audio_active = None if audio_rms is None else audio_rms >= session.get("audio_threshold", 0.02)
    tilts = [float(d["tilt"]) for d in detections if d.get("tilt") is not None]
    sample = {"t": elapsed, "visible": len(detections), "motion": motion,
              "audio_rms": None if audio_rms is None else round(float(audio_rms), 4),
              "audio_active": audio_active, "activity": activity_score(motion, audio_active),
              "face_tilt": round(statistics.mean(tilts), 1) if tilts else None,
              "tilt_count": len(tilts), "max_still": round(max_still, 1) if measured else None}
    session["samples"].append(sample)
    session["duration"] = max(float(session.get("duration", 0)), elapsed)
    return sample


def status_for(roster_entry: dict, tracks: dict[str, dict]) -> tuple[str, str]:
    manual = roster_entry.get("manual_status", "auto")
    if manual in ("present", "absent", "unmarked"):
        return manual, "manual"
    track = tracks.get(roster_entry.get("track_id"))
    if track and track.get("qualified"):
        return "present", "tracked"
    return "unmarked", "tracked" if track else "none"


def _mean(values: list[float]) -> float | None:
    return round(statistics.mean(values), 1) if values else None


def make_timeline(session: dict) -> list[dict]:
    samples = session.get("samples", [])
    duration = max(float(session.get("duration", 0)), samples[-1]["t"] if samples else 0)
    # Keep charts legible both for short tests and full-length classes.
    bucket_seconds = 300 if duration >= 1800 else (60 if duration >= 300 else 10)
    buckets: dict[int, list[dict]] = {}
    for sample in samples:
        start = int(sample["t"] // bucket_seconds) * bucket_seconds
        buckets.setdefault(start, []).append(sample)
    timeline = []
    for start, values in sorted(buckets.items()):
        activities = [v["activity"] for v in values if v.get("activity") is not None]
        motions = [v["motion"] * 100 for v in values if v.get("motion") is not None]
        audio = [100.0 if v["audio_active"] else 0.0 for v in values if v.get("audio_active") is not None]
        timeline.append({"t": start, "end": start + bucket_seconds, "samples": len(values),
                         "activity": _mean(activities), "movement": _mean(motions), "audio": _mean(audio)})
    return timeline


def elapsed_label(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds >= 3600:
        return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}:{seconds % 60:02d}"
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def derive_insights(session: dict, stats: dict, timeline: list[dict]) -> list[dict]:
    """Transparent, rule-based decision support, not a generative AI or diagnosis."""
    out = []
    usable = [b for b in timeline if b["activity"] is not None and b["samples"] >= 2]
    if usable:
        low = min(usable, key=lambda b: b["activity"])
        if low["activity"] < 50:
            out.append({"kind": "check-in", "icon": "sparkle", "eyebrow": "MOMENT TO CHECK IN",
                        "title": f"A quieter stretch at {elapsed_label(low['t'])}",
                        "body": "Observed activity was lower here. Consider a quick question or short reset; quiet can also mean focused work.",
                        "evidence": f"Activity signal: {round(low['activity'])}/100 · {low['samples']} samples"})
        else:
            out.append({"kind": "check-in", "icon": "sparkle", "eyebrow": "TEACHING PROMPT",
                        "title": "Make room for a check-in",
                        "body": "A short question or reflection can help you understand how learners are doing. Signals alone cannot tell you.",
                        "evidence": f"Based on {stats['samples']} activity samples"})
        audio_buckets = [b for b in timeline if b["audio"] is not None and b["samples"] >= 2]
        if audio_buckets:
            peak = max(audio_buckets, key=lambda b: b["audio"])
            out.append({"kind": "audio", "icon": "sound", "eyebrow": "AUDIO ACTIVITY",
                        "title": f"Revisit the moment at {elapsed_label(peak['t'])}",
                        "body": "Sound activity peaked in this interval. If it was a discussion, a brief recap could reinforce its key points.",
                        "evidence": f"Sound detected in {round(peak['audio'])}% of sampled moments · could include noise"})
    if stats["unmarked"]:
        out.append({"kind": "attendance", "icon": "users", "eyebrow": "ATTENDANCE REVIEW",
                    "title": f"Review {stats['unmarked']} unmarked {'learner' if stats['unmarked'] == 1 else 'learners'}",
                    "body": "Check the roster and assign anonymous tracks manually. An unmarked learner is not automatically absent.",
                    "evidence": "Roster review · human confirmation needed"})
    elif stats["unmapped_qualified"]:
        out.append({"kind": "attendance", "icon": "users", "eyebrow": "ATTENDANCE REVIEW",
                    "title": f"Match {stats['unmapped_qualified']} anonymous {'track' if stats['unmapped_qualified'] == 1 else 'tracks'}",
                    "body": "Give each observed track a roster match only after checking it yourself. Tracking does not identify people.",
                    "evidence": "Anonymous tracks · manual matching"})
    if not session["samples"]:
        out.append({"kind": "start", "icon": "sparkle", "eyebrow": "READY WHEN YOU ARE",
                    "title": "Start with a short capture",
                    "body": "Choose a camera or video, then let the system sample a few frames. You can review every attendance record.",
                    "evidence": "No observations yet"})
    if session["samples"] and stats["audio_activity"] is None:
        out.append({"kind": "audio", "icon": "sound", "eyebrow": "OPTIONAL SIGNAL",
                    "title": "Audio activity is off",
                    "body": "With permission, you can enable microphone or video audio for a group-level sound signal. No words are transcribed.",
                    "evidence": "Audio not available for this session"})
    if len(out) < 3 and session["samples"]:
        out.append({"kind": "interpret", "icon": "shield", "eyebrow": "KEEP IN MIND",
                    "title": "Interpret signals with context",
                    "body": "Movement and sound may reflect noise or accessibility needs. They are not measures of attention or learning.",
                    "evidence": "Human judgment comes first"})
    return out[:3]


def summarize(session: dict) -> dict:
    tracks = {t["id"]: t for t in session.get("tracks", [])}
    roster = session.get("roster", [])
    rows = []
    for r in roster:
        status, source = status_for(r, tracks)
        rows.append({**r, "status": status, "status_source": source, "track": tracks.get(r.get("track_id"))})
    mapped = {r.get("track_id") for r in roster if r.get("track_id")}
    unmapped = [t for t in session.get("tracks", []) if t["id"] not in mapped]
    samples = session.get("samples", [])
    audio = [100.0 if s["audio_active"] else 0.0 for s in samples if s.get("audio_active") is not None]
    activity = [s["activity"] for s in samples if s.get("activity") is not None]
    movement = [s["motion"] * 100 for s in samples if s.get("motion") is not None]
    tilts = [s["face_tilt"] for s in samples if s.get("face_tilt") is not None]
    still = [s["max_still"] for s in samples if s.get("max_still") is not None]
    qualified = sum(1 for t in tracks.values() if t.get("qualified"))
    stats = {"roster_total": len(roster), "present": sum(1 for r in rows if r["status"] == "present"),
             "unmarked": sum(1 for r in rows if r["status"] == "unmarked"),
             "absent": sum(1 for r in rows if r["status"] == "absent"),
             "qualified_tracks": qualified, "track_count": len(tracks),
             "unmapped_qualified": sum(1 for t in unmapped if t.get("qualified")),
             "activity": _mean(activity), "audio_activity": _mean(audio), "movement": _mean(movement),
             "mean_tilt": _mean(tilts), "tilt_samples": len(tilts),
             "longest_still": max(still) if still else None,
             "samples": len(samples), "duration": float(session.get("duration", 0))}
    timeline = make_timeline(session)
    return {"stats": stats, "roster_rows": rows, "unmapped_tracks": unmapped,
            "timeline": timeline, "suggestions": derive_insights(session, stats, timeline)}


def absolute_time(started_at: str, seconds: float) -> str:
    try:
        dt = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        return (dt + timedelta(seconds=seconds)).isoformat(timespec="seconds")
    except (TypeError, ValueError):
        return ""

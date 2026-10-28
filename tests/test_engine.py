import unittest
from pathlib import Path

import cv2
from engine import Detector, activity_score, make_timeline, process_detections, summarize
from store import DEFAULT_SETTINGS, demo_session, new_session


def face(x=0.25):
    return {"box": [x, 0.2, 0.12, 0.18], "tilt": 2.0}


class EngineTests(unittest.TestCase):
    def setUp(self):
        settings = dict(DEFAULT_SETTINGS, presence_threshold=6, sample_interval=2)
        self.session = new_session("Test", "", "video", settings, ["Ada"])
        self.runtime = {}

    def sample(self, t, detections=None, rms=None):
        return process_detections(self.session, self.runtime, [face()] if detections is None else detections, t, rms)

    def test_presence_requires_multiple_samples_and_manual_match(self):
        for t in (0, 2, 4):
            self.sample(t)
        self.assertFalse(self.session["tracks"][0]["qualified"])
        self.sample(6)
        track = self.session["tracks"][0]
        self.assertTrue(track["qualified"])
        self.assertEqual(track["seen_seconds"], 6)
        # A detection alone never claims a named learner is present.
        self.assertEqual(summarize(self.session)["stats"]["present"], 0)
        self.session["roster"][0]["track_id"] = track["id"]
        self.assertEqual(summarize(self.session)["stats"]["present"], 1)
        self.assertEqual([e["type"] for e in self.session["events"]], ["detected", "qualified"])

    def test_gap_creates_a_new_track_and_no_unobserved_credit(self):
        self.sample(0)
        self.sample(20)
        self.assertEqual(len(self.session["tracks"]), 2)
        self.assertEqual([t["seen_seconds"] for t in self.session["tracks"]], [0.0, 0.0])
        self.assertFalse(any(t["qualified"] for t in self.session["tracks"]))

    def test_partial_gap_credit_is_capped(self):
        self.sample(0)
        self.sample(6)
        self.assertEqual(self.session["tracks"][0]["seen_seconds"], 3.0)
        self.assertFalse(self.session["tracks"][0]["qualified"])

    def test_out_of_order_samples_are_rejected(self):
        self.sample(2)
        with self.assertRaises(ValueError):
            self.sample(2)
        with self.assertRaises(ValueError):
            self.sample(1)

    def test_activity_formula_and_missing_sources(self):
        self.assertEqual(activity_score(0.5, True), 67.5)
        self.assertEqual(activity_score(0.5, False), 32.5)
        self.assertEqual(activity_score(0.4, None), 40.0)
        self.assertEqual(activity_score(None, True), 100.0)
        self.assertIsNone(activity_score(None, None))

    def test_override_and_not_marked_are_distinct_from_absent(self):
        row = self.session["roster"][0]
        self.assertEqual(summarize(self.session)["roster_rows"][0]["status"], "unmarked")
        row["manual_status"] = "absent"
        self.assertEqual(summarize(self.session)["stats"]["absent"], 1)
        row["manual_status"] = "present"
        self.assertEqual(summarize(self.session)["stats"]["present"], 1)

    def test_demo_is_consistent_and_labeled(self):
        demo = demo_session()
        summary = summarize(demo)
        self.assertEqual(demo["status"], "demo")
        self.assertEqual(summary["stats"]["roster_total"], 28)
        self.assertEqual(summary["stats"]["present"], 24)
        self.assertEqual(summary["stats"]["unmarked"], 4)
        self.assertGreater(len(make_timeline(demo)), 1)
        self.assertTrue(any(i["kind"] == "check-in" for i in summary["suggestions"]))

    def test_silent_and_absent_audio_are_not_the_same(self):
        first = self.sample(0, rms=None)
        second = self.sample(2, rms=0.0)
        third = self.sample(4, rms=0.1)
        self.assertIsNone(first["audio_active"])
        self.assertIs(second["audio_active"], False)
        self.assertIs(third["audio_active"], True)
        self.assertEqual(summarize(self.session)["stats"]["audio_activity"], 50.0)

    def test_real_opencv_on_bundled_synthetic_clip(self):
        clip = Path(__file__).resolve().parents[1] / 'static' / 'sample.webm'
        capture = cv2.VideoCapture(str(clip))
        if not capture.isOpened():
            self.skipTest('This OpenCV build cannot decode WebM')
        session = new_session('Synthetic test', '', 'video', DEFAULT_SETTINGS, [])
        runtime, detector = {}, Detector()
        try:
            for t in (0, 2, 4, 6, 8, 10, 12):
                capture.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
                ok, frame = capture.read()
                self.assertTrue(ok, f'Could not read synthetic sample at {t}s')
                detections = detector.detect(frame, 'face')
                self.assertTrue(detections, f'No synthetic face detected at {t}s')
                process_detections(session, runtime, detections, t, None)
        finally:
            capture.release()
        self.assertEqual(summarize(session)['stats']['qualified_tracks'], 1)


if __name__ == '__main__':
    unittest.main()

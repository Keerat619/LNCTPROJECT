import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import cv2
import numpy as np

import app
from store import Store


class FakeDetector:
    def detect(self, image, mode):
        return [{"box": [0.2, 0.2, 0.2, 0.2], "tilt": None}]


class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        app.STORE = Store(cls.tmp.name)
        app.DETECTOR = FakeDetector()
        app.RUNTIME = {}
        app.Handler.log_message = lambda *args: None
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        ok, encoded = cv2.imencode('.jpg', np.zeros((64, 64, 3), dtype=np.uint8))
        assert ok
        cls.jpeg = encoded.tobytes()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        hdr = dict(headers or {})
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            hdr['Content-Type'] = 'application/json'
        req = Request(self.url + path, data=body, method=method, headers=hdr)
        try:
            with urlopen(req, timeout=5) as res:
                return res.status, res.read(), res.headers
        except HTTPError as e:
            return e.code, e.read(), e.headers

    def test_end_to_end_manual_assignment_csv_and_sample_separation(self):
        status, body, _ = self.request('POST', '/api/sessions', {
            'name': 'Test session', 'source': 'video', 'consent': True,
            'roster': ['Ada', '=FORMULA'], 'settings': {'presence_threshold': 4, 'sample_interval': 2}})
        self.assertEqual(status, 201)
        session = json.loads(body); sid = session['id']
        self.assertEqual(session['stats']['present'], 0)
        status, _, _ = self.request('POST', f'/api/sessions/{sid}/pause', {'media_kind': 'synthetic'})
        self.assertEqual(status, 200)
        for t in (0, 2, 4):
            status, result, _ = self.request('POST', f'/api/sessions/{sid}/frame', self.jpeg,
                {'Content-Type': 'image/jpeg', 'X-Elapsed': str(t), 'X-Audio-RMS': '0.04'})
            self.assertEqual(status, 200)
        result = json.loads(result)
        self.assertEqual(result['stats']['qualified_tracks'], 1)
        self.assertEqual(result['stats']['present'], 0)
        self.assertEqual(result['detections'][0]['track_id'], 'P-001')
        status, data, _ = self.request('GET', f'/api/sessions/{sid}')
        session = json.loads(data)
        self.assertEqual(session['media_kind'], 'synthetic')
        row1, row2 = session['roster_rows']
        status, data, _ = self.request('PATCH', f'/api/sessions/{sid}/roster/{row1["id"]}', {'track_id': 'P-001'})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)['stats']['present'], 1)
        status, _, _ = self.request('PATCH', f'/api/sessions/{sid}/roster/{row2["id"]}', {'track_id': 'P-001'})
        self.assertEqual(status, 400)
        status, csv_data, headers = self.request('GET', f'/api/sessions/{sid}/export.csv')
        self.assertEqual(status, 200)
        self.assertIn("'=FORMULA", csv_data.decode('utf-8-sig'))
        self.assertIn('Ada', csv_data.decode('utf-8-sig'))
        status, _, _ = self.request('POST', f'/api/sessions/{sid}/pause', {'media_kind': 'user'})
        self.assertEqual(status, 400)
        status, _, _ = self.request('POST', f'/api/sessions/{sid}/close', {})
        self.assertEqual(status, 200)
        status, _, _ = self.request('POST', f'/api/sessions/{sid}/frame', self.jpeg, {'X-Elapsed': '6'})
        self.assertEqual(status, 400)
        stored = app.STORE.file.read_bytes()
        self.assertNotIn(self.jpeg, stored)
        self.assertNotIn(b'frame_bytes', stored)

    def test_consent_required(self):
        status, body, _ = self.request('POST', '/api/sessions', {'name': 'No consent', 'source': 'camera'})
        self.assertEqual(status, 400)
        self.assertIn('permission', json.loads(body)['error'])


if __name__ == '__main__':
    unittest.main()

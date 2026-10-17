import csv
import io
import json
import os
import sqlite3
import tempfile
import unittest
import zipfile

from app.exporting import build_session_zip, list_observation_sessions


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp.name, "panettone.db")
        self.photo_dir = os.path.join(self.temp.name, "photos")
        os.makedirs(self.photo_dir)
        with sqlite3.connect(self.db_path) as db:
            db.executescript("""
                CREATE TABLE readings (id INTEGER PRIMARY KEY, captured_at TEXT, temperature_c REAL,
                    humidity_rh REAL, sensor_ok INTEGER, error TEXT);
                CREATE TABLE photos (id INTEGER PRIMARY KEY, captured_at TEXT, filename TEXT,
                    camera_ok INTEGER, error TEXT);
                CREATE TABLE monitoring_control (id INTEGER PRIMARY KEY, active INTEGER, changed_at TEXT);
                INSERT INTO readings VALUES (1,'2026-10-16T20:00:00+00:00',25.0,60.0,1,NULL);
                INSERT INTO readings VALUES (2,'2026-10-16T20:00:30+00:00',NULL,NULL,0,'Timeout');
                INSERT INTO photos VALUES (1,'2026-10-16T20:00:02+00:00','20261016-220002.jpg',1,NULL);
                INSERT INTO photos VALUES (2,'2026-10-16T20:02:02+00:00','',0,'CameraError');
                INSERT INTO monitoring_control VALUES (1,1,'2026-10-16T20:00:00+00:00');
            """)
        self.photo_bytes = b"original-photo-bytes"
        with open(os.path.join(self.photo_dir, "20261016-220002.jpg"), "wb") as photo:
            photo.write(self.photo_bytes)

    def tearDown(self):
        self.temp.cleanup()

    def test_export_has_raw_rows_original_photo_and_no_events_inferred(self):
        archive, metadata = build_session_zip(
            self.db_path, self.photo_dir, "2026-10-16T20:00:00+00:00", "2026-10-16T20:03:00+00:00",
            app_version="test", timezone_name="Europe/Madrid")
        with zipfile.ZipFile(archive) as zipped:
            self.assertIsNone(zipped.testzip())
            self.assertEqual(zipped.read("photos/20261016-220002.jpg"), self.photo_bytes)
            readings = list(csv.DictReader(io.TextIOWrapper(zipped.open("readings.csv"), encoding="utf-8")))
            photos = list(csv.DictReader(io.TextIOWrapper(zipped.open("photos.csv"), encoding="utf-8")))
            events = list(csv.DictReader(io.TextIOWrapper(zipped.open("events.csv"), encoding="utf-8")))
            self.assertEqual(len(readings), 2)
            self.assertEqual(readings[1]["quality"], "error")
            self.assertEqual(len(photos), 2)
            self.assertEqual(photos[0]["capture_status"], "ok")
            self.assertEqual(photos[1]["capture_status"], "capture_error")
            self.assertEqual(events, [])
            self.assertEqual(json.loads(zipped.read("metadata.json"))["counts"]["photo_files_exported"], 1)
        self.assertEqual(metadata["counts"]["reading_errors"], 1)
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM readings").fetchone()[0], 2)
        archive.close()

    def test_observation_sessions_split_only_at_long_gaps(self):
        sessions = list_observation_sessions(self.db_path)
        self.assertEqual(len(sessions), 1)
        self.assertTrue(sessions[0]["inferred"])
        self.assertTrue(sessions[0]["id"].startswith("obs-20261016T200000Z"))


if __name__ == "__main__":
    unittest.main()

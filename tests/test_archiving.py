import json
import sqlite3
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import archiving


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.db_path = str(root / "panettone.db")
        self.photo_dir = root / "photos"
        self.photo_dir.mkdir()
        self.data_dir = root / "data"
        self.data_dir.mkdir()
        with sqlite3.connect(self.db_path) as db:
            db.executescript("""
              CREATE TABLE fermentations(id INTEGER PRIMARY KEY,started_at TEXT,ended_at TEXT,
                archived_at TEXT,archive_filename TEXT,archive_sample_minutes INTEGER,archive_saved_bytes INTEGER);
              CREATE TABLE photos(id INTEGER PRIMARY KEY,captured_at TEXT,filename TEXT,growth_score REAL,
                growth_detected INTEGER,analysis_json TEXT,camera_ok INTEGER,error TEXT,fermentation_id INTEGER,
                important INTEGER DEFAULT 0,archived_at TEXT,archived_filename TEXT);
              CREATE TABLE readings(id INTEGER PRIMARY KEY,captured_at TEXT,temperature_c REAL,humidity_rh REAL,
                sensor_ok INTEGER,error TEXT,fermentation_id INTEGER);
              CREATE TABLE events(id INTEGER PRIMARY KEY,fermentation_id INTEGER,occurred_at TEXT,event_type TEXT,details TEXT);
              CREATE TABLE monitoring_control(id INTEGER PRIMARY KEY,active INTEGER,changed_at TEXT);
              CREATE TABLE visual_calibrations(id INTEGER PRIMARY KEY,fermentation_id INTEGER,photo_id INTEGER,data TEXT,signature TEXT,active INTEGER);
              CREATE TABLE visual_estimates(photo_id INTEGER,fermentation_id INTEGER,signature TEXT,algorithm_version TEXT,image_stamp TEXT,data TEXT);
            """)
            self.started = datetime(2026, 10, 16, 20, tzinfo=timezone.utc)
            ended = self.started + timedelta(hours=1)
            db.execute("INSERT INTO fermentations VALUES(1,?,?,NULL,NULL,NULL,NULL)",
                       (self.started.isoformat(), ended.isoformat()))
            db.execute("INSERT INTO monitoring_control VALUES(1,1,?)", (self.started.isoformat(),))
            db.execute("INSERT INTO readings VALUES(1,?,27.0,60.0,1,NULL,1)", (self.started.isoformat(),))
            db.execute("INSERT INTO events VALUES(1,1,?,'fermentation_start','inici')", (self.started.isoformat(),))
            percents = [0, 40, 105, 115, 160, 205, 220, 225]
            for index, percent in enumerate(percents, 1):
                captured = self.started + timedelta(minutes=5 * (index - 1))
                stamp = captured.astimezone(timezone(timedelta(hours=2))).strftime("%Y%m%d-%H%M%S")
                filename = f"{stamp}.jpg"
                (self.photo_dir / filename).write_bytes(bytes([index]) * (100 + index))
                db.execute("INSERT INTO photos VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                           (index, captured.isoformat(), filename, .2, 1, "{}", 1, None, 1,
                            int(index == 2), None, None))
                db.execute("INSERT INTO visual_estimates VALUES(?,?,?,?,?,?)",
                           (index, 1, "sig", "v1", f"stamp-{index}", json.dumps({"valid": True, "percent": percent, "factor": 1 + percent/100})))
            db.execute("INSERT INTO visual_calibrations VALUES(1,1,1,?,'sig',1)",
                       (json.dumps({"photo_id": 1}),))

    def tearDown(self):
        self.temp.cleanup()

    def test_preview_retains_reference_milestones_max_sample_and_important(self):
        result = archiving.preview(self.db_path, str(self.photo_dir), 1, 10)
        keep = {item["id"] for item in result["photos"] if item["keep"]}
        self.assertTrue({1, 2, 3, 6, 8}.issubset(keep))
        self.assertIn("Referència calibrada", next(p for p in result["photos"] if p["id"] == 1)["required_reasons"])
        self.assertIn("Primera duplicació", next(p for p in result["photos"] if p["id"] == 3)["required_reasons"])
        self.assertIn("Primera triplicació", next(p for p in result["photos"] if p["id"] == 6)["required_reasons"])
        self.assertIn("Marcada com important", next(p for p in result["photos"] if p["id"] == 2)["required_reasons"])
        self.assertGreater(result["removed_count"], 0)

    def test_archive_requires_verified_export_and_keeps_verified_recovery_zip(self):
        with self.assertRaises(ValueError):
            archiving.archive(self.db_path, str(self.photo_dir), str(self.data_dir), 1, 10, [], False)
        before = archiving.preview(self.db_path, str(self.photo_dir), 1, 10)
        keep = [item["id"] for item in before["photos"] if item["keep"]]
        result = archiving.archive(self.db_path, str(self.photo_dir), str(self.data_dir), 1, 10, keep, True)
        archive_path = Path(result["archive_path"])
        self.assertTrue(archive_path.is_file())
        with zipfile.ZipFile(archive_path) as archive:
            self.assertIsNone(archive.testzip())
            self.assertTrue({"readings.csv", "photos.csv", "events.csv", "metadata.json"}.issubset(archive.namelist()))
            self.assertEqual(len([name for name in archive.namelist() if name.startswith("photos/")]), 8)
        with sqlite3.connect(self.db_path) as db:
            archived = db.execute("SELECT archived_at,archive_filename FROM fermentations WHERE id=1").fetchone()
            removed = db.execute("SELECT count(*) FROM photos WHERE fermentation_id=1 AND archived_at IS NOT NULL").fetchone()[0]
        self.assertIsNotNone(archived[0])
        self.assertEqual(archived[1], archive_path.name)
        self.assertEqual(removed, result["removed_count"])
        self.assertGreater(result["archive_bytes"], 0)


if __name__ == "__main__":
    unittest.main()

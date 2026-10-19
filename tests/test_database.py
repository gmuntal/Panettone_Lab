import os
import sqlite3
import tempfile
import unittest
from pathlib import Path


class DatabaseMigrationTests(unittest.TestCase):
    def test_additive_migration_preserves_old_rows_and_links_new_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = os.path.join(directory, "panettone.db")
            photo_path = os.path.join(directory, "photos")
            os.makedirs(photo_path)
            db = sqlite3.connect(database_path)
            db.executescript("""
                CREATE TABLE readings(id INTEGER PRIMARY KEY AUTOINCREMENT,captured_at TEXT NOT NULL,
                  temperature_c REAL,humidity_rh REAL,sensor_ok INTEGER NOT NULL DEFAULT 0,error TEXT);
                CREATE TABLE photos(id INTEGER PRIMARY KEY AUTOINCREMENT,captured_at TEXT NOT NULL,
                  filename TEXT NOT NULL,growth_score REAL,growth_detected INTEGER,analysis_json TEXT,
                  camera_ok INTEGER NOT NULL DEFAULT 0,error TEXT);
                CREATE TABLE growth_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE monitoring_control(id INTEGER PRIMARY KEY CHECK(id=1),active INTEGER NOT NULL DEFAULT 0,changed_at TEXT NOT NULL);
                INSERT INTO readings(captured_at,temperature_c,humidity_rh,sensor_ok) VALUES('2026-10-16T20:00:00+00:00',24.5,60,1);
                INSERT INTO photos(captured_at,filename,camera_ok) VALUES('2026-10-16T20:00:00+00:00','old.jpg',1);
            """)
            db.commit(); db.close()
            os.environ["DATA_DIR"] = directory
            os.environ["DATABASE_PATH"] = database_path
            os.environ["PHOTO_DIR"] = photo_path
            from app import config, database
            config.settings = config.Settings(data_dir=directory, database_path=database_path,
                                              photo_dir=photo_path)
            database.settings = config.settings
            database.init_db()
            backups = list((Path(directory) / "backups").glob("pre-v0.10.0-*.sqlite3"))
            self.assertEqual(len(backups), 1)
            with sqlite3.connect(backups[0]) as backup:
                self.assertEqual(backup.execute("SELECT count(*) FROM readings").fetchone()[0], 1)
                self.assertNotIn("archived_at", {row[1] for row in backup.execute("PRAGMA table_info(photos)")})
            period_backups = list((Path(directory) / "backups").glob("pre-v0.11.0-*.sqlite3"))
            self.assertEqual(len(period_backups), 1)
            with sqlite3.connect(period_backups[0]) as backup:
                self.assertEqual(backup.execute("SELECT count(*) FROM readings").fetchone()[0], 1)
                self.assertNotIn("camera_enabled", {row[1] for row in backup.execute("PRAGMA table_info(fermentations)")})
            calibration = {"left_x": .21, "right_x": .79, "bottom_y": .94,
                           "initial_surface_y": .71, "photo_id": 1,
                           "captured_at": "2026-10-16T20:00:00+00:00"}
            database.save_growth_calibration(calibration)
            self.assertEqual(database.growth_config()["calibration"], calibration)
            with database.connect() as migrated:
                self.assertEqual(migrated.execute("SELECT count(*) FROM readings").fetchone()[0], 1)
                self.assertEqual(migrated.execute("SELECT count(*) FROM photos").fetchone()[0], 1)
                self.assertIn("fermentation_id", {row[1] for row in migrated.execute("PRAGMA table_info(readings)")})
            fermentation = database.start_fermentation({"starter_mass_g": 100, "flour_g": 100, "water_g": 50})
            database.add_reading(25.0, 62.0)
            database.add_photo("new.jpg")
            with database.connect() as migrated:
                self.assertIsNone(migrated.execute("SELECT fermentation_id FROM readings WHERE id=1").fetchone()[0])
                self.assertEqual(migrated.execute("SELECT fermentation_id FROM readings WHERE id=2").fetchone()[0], fermentation["id"])
                self.assertEqual(migrated.execute("SELECT fermentation_id FROM photos WHERE id=2").fetchone()[0], fermentation["id"])
            self.assertIsNotNone(database.end_fermentation(fermentation["id"])["ended_at"])

    def test_period_adjustment_is_audited_and_keeps_original_data(self):
        with tempfile.TemporaryDirectory() as directory:
            os.environ["DATA_DIR"] = directory
            os.environ["DATABASE_PATH"] = os.path.join(directory, "panettone.db")
            os.environ["PHOTO_DIR"] = os.path.join(directory, "photos")
            from app import config, database
            config.settings = config.Settings(data_dir=directory, database_path=os.path.join(directory, "panettone.db"),
                                              photo_dir=os.path.join(directory, "photos"))
            database.settings = config.settings
            database.init_db()
            session = database.start_fermentation({"camera_enabled": False})
            self.assertFalse(database.photo_capture_enabled())
            database.add_reading(26.5, 61.0)
            database.add_photo("kept.jpg")
            ended = database.end_fermentation(session["id"])
            start, end = "2026-10-16T20:00:00+00:00", "2026-10-17T09:00:00+00:00"
            adjusted = database.update_fermentation_period(session["id"], start, end)
            self.assertEqual(adjusted["started_at"], start)
            self.assertEqual(adjusted["ended_at"], end)
            with database.connect() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM readings").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT count(*) FROM photos").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT count(*) FROM fermentation_period_edits WHERE fermentation_id=?", (session["id"],)).fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT occurred_at FROM events WHERE event_type='fermentation_start'").fetchone()[0], start)
            self.assertEqual(ended["id"], session["id"])


if __name__ == "__main__":
    unittest.main()

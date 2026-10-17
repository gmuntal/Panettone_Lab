import os
import sqlite3
import tempfile
import unittest


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


if __name__ == "__main__":
    unittest.main()

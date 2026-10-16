import os
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from .config import settings
from .growth_detection import DEFAULT_ROI


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_db() -> None:
    os.makedirs(settings.data_dir, exist_ok=True)
    os.makedirs(settings.photo_dir, exist_ok=True)
    with connect() as db:
        db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            captured_at TEXT NOT NULL,
            temperature_c REAL,
            humidity_rh REAL,
            sensor_ok INTEGER NOT NULL DEFAULT 0,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_readings_captured ON readings(captured_at);
        CREATE TABLE IF NOT EXISTS photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            captured_at TEXT NOT NULL,
            filename TEXT NOT NULL,
            growth_score REAL,
            growth_detected INTEGER,
            analysis_json TEXT,
            camera_ok INTEGER NOT NULL DEFAULT 0,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_photos_captured ON photos(captured_at);
        CREATE TABLE IF NOT EXISTS growth_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS monitoring_control (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            active INTEGER NOT NULL DEFAULT 0,
            changed_at TEXT NOT NULL
        );
        """)
        db.execute("INSERT OR IGNORE INTO monitoring_control(id,active,changed_at) VALUES(1,0,?)",
                   (utc_now(),))


def monitoring_state():
    with connect() as db:
        row = db.execute("SELECT active,changed_at FROM monitoring_control WHERE id=1").fetchone()
    return {"active": bool(row["active"]), "changed_at": row["changed_at"]}


def set_monitoring_active(active):
    with connect() as db:
        db.execute("UPDATE monitoring_control SET active=?,changed_at=? WHERE id=1",
                   (int(bool(active)), utc_now()))
    return monitoring_state()


@contextmanager
def connect():
    db = sqlite3.connect(settings.database_path, timeout=15)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys=ON")
        yield db
        db.commit()
    finally:
        db.close()


def add_reading(temperature, humidity, error=None):
    with connect() as db:
        db.execute("INSERT INTO readings(captured_at,temperature_c,humidity_rh,sensor_ok,error) VALUES(?,?,?,?,?)",
                   (utc_now(), temperature, humidity, int(error is None), error))


def add_photo(filename, error=None, analysis=None):
    analysis = analysis or {}
    with connect() as db:
        db.execute("""INSERT INTO photos(captured_at,filename,growth_score,growth_detected,
                   analysis_json,camera_ok,error) VALUES(?,?,?,?,?,?,?)""",
                   (utc_now(), filename, analysis.get("growth_score"), analysis.get("growth_detected"),
                    analysis.get("analysis_json"), int(error is None), error))


def growth_config():
    with connect() as db:
        rows = {row["key"]: row["value"] for row in db.execute("SELECT key,value FROM growth_settings")}
    try:
        roi = json.loads(rows.get("roi", ""))
    except (TypeError, ValueError):
        roi = None
    try:
        baseline = json.loads(rows.get("baseline", ""))
    except (TypeError, ValueError):
        baseline = None
    if not isinstance(roi, dict) or set(("x0", "y0", "x1", "y1")) - roi.keys():
        roi = dict(DEFAULT_ROI)
    return {"roi": roi, "baseline": baseline if isinstance(baseline, dict) else None}


def save_growth_roi(roi):
    with connect() as db:
        db.execute("INSERT INTO growth_settings(key,value) VALUES('roi',?) "
                   "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(roi),))
        # A reference measured in a different image region is not comparable.
        db.execute("DELETE FROM growth_settings WHERE key='baseline'")


def set_growth_baseline(height_ratio, captured_at):
    baseline = {"height_ratio": height_ratio, "captured_at": captured_at}
    with connect() as db:
        db.execute("INSERT INTO growth_settings(key,value) VALUES('baseline',?) "
                   "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(baseline),))
    return baseline


def latest_analyzed_photo():
    with connect() as db:
        row = db.execute("""SELECT * FROM photos WHERE camera_ok=1 AND analysis_json IS NOT NULL
                          ORDER BY captured_at DESC LIMIT 1""").fetchone()
    return dict(row) if row else None


def update_photo_analysis(photo_id, analysis):
    with connect() as db:
        db.execute("UPDATE photos SET growth_score=?,growth_detected=?,analysis_json=? WHERE id=?",
                   (analysis.get("growth_score"), analysis.get("growth_detected"),
                    analysis.get("analysis_json"), photo_id))


def recent_readings(hours=24):
    with connect() as db:
        return [dict(row) for row in db.execute(
            "SELECT * FROM readings WHERE captured_at >= datetime('now', ?) ORDER BY captured_at",
            (f"-{int(hours)} hours",))]


def recent_photos(limit=48):
    with connect() as db:
        return [dict(row) for row in db.execute(
            "SELECT * FROM photos ORDER BY captured_at DESC LIMIT ?", (int(limit),))]


def growth_history(limit=500):
    with connect() as db:
        return [dict(row) for row in db.execute(
            """SELECT id,captured_at,filename,growth_score,growth_detected,analysis_json
               FROM photos WHERE camera_ok=1 AND growth_score IS NOT NULL
               ORDER BY captured_at DESC LIMIT ?""", (int(limit),))]


def latest_state():
    with connect() as db:
        reading = db.execute("SELECT * FROM readings ORDER BY captured_at DESC LIMIT 1").fetchone()
        photo = db.execute("SELECT * FROM photos ORDER BY captured_at DESC LIMIT 1").fetchone()
    return {"reading": dict(reading) if reading else None, "photo": dict(photo) if photo else None}

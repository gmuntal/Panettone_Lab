import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from .config import settings


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
        """)


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


def add_photo(filename, error=None):
    with connect() as db:
        db.execute("INSERT INTO photos(captured_at,filename,camera_ok,error) VALUES(?,?,?,?)",
                   (utc_now(), filename, int(error is None), error))


def recent_readings(hours=24):
    with connect() as db:
        return [dict(row) for row in db.execute(
            "SELECT * FROM readings WHERE captured_at >= datetime('now', ?) ORDER BY captured_at",
            (f"-{int(hours)} hours",))]


def recent_photos(limit=48):
    with connect() as db:
        return [dict(row) for row in db.execute(
            "SELECT * FROM photos ORDER BY captured_at DESC LIMIT ?", (int(limit),))]


def latest_state():
    with connect() as db:
        reading = db.execute("SELECT * FROM readings ORDER BY captured_at DESC LIMIT 1").fetchone()
        photo = db.execute("SELECT * FROM photos ORDER BY captured_at DESC LIMIT 1").fetchone()
    return {"reading": dict(reading) if reading else None, "photo": dict(photo) if photo else None}

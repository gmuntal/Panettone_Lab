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
        CREATE TABLE IF NOT EXISTS fermentations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            starter_mass_g REAL,
            flour_g REAL,
            water_g REAL,
            flour_type TEXT,
            hydration_pct REAL,
            initial_ph REAL,
            initial_dough_temp_c REAL,
            target_fermenter_temp_c REAL,
            notes TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_fermentations_started ON fermentations(started_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fermentations_one_active
            ON fermentations((1)) WHERE ended_at IS NULL;
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fermentation_id INTEGER REFERENCES fermentations(id),
            occurred_at TEXT NOT NULL,
            event_type TEXT NOT NULL,
            starter_mass_g REAL,
            flour_g REAL,
            water_g REAL,
            flour_type TEXT,
            hydration_pct REAL,
            ph REAL,
            dough_temp_c REAL,
            target_temp_c REAL,
            details TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at);
        CREATE INDEX IF NOT EXISTS idx_events_fermentation_time ON events(fermentation_id,occurred_at);
        CREATE TABLE IF NOT EXISTS fermenter_settings (
            id INTEGER PRIMARY KEY CHECK (id=1),
            mode TEXT NOT NULL DEFAULT 'stopped',
            target_c REAL NOT NULL DEFAULT 27.0,
            hysteresis_c REAL NOT NULL DEFAULT 0.3,
            min_switch_seconds INTEGER NOT NULL DEFAULT 60,
            max_on_seconds INTEGER NOT NULL DEFAULT 1800,
            overtemp_c REAL NOT NULL DEFAULT 35.0,
            schedule_enabled INTEGER NOT NULL DEFAULT 0,
            continuous INTEGER NOT NULL DEFAULT 1,
            schedule_start TEXT NOT NULL DEFAULT '00:00',
            schedule_end TEXT NOT NULL DEFAULT '23:59',
            manual_on INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fermenter_runtime (
            id INTEGER PRIMARY KEY CHECK (id=1),
            observed_at TEXT,
            temperature_c REAL,
            humidity_rh REAL,
            sensor_ok INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            switch0_on INTEGER,
            switch1_on INTEGER,
            simulated_heater_on INTEGER NOT NULL DEFAULT 0,
            reason TEXT NOT NULL DEFAULT 'stopped',
            heater_on_since TEXT,
            last_switch_at TEXT,
            lockout_reason TEXT
        );
        CREATE TABLE IF NOT EXISTS fermenter_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            occurred_at TEXT NOT NULL,
            fermentation_id INTEGER REFERENCES fermentations(id),
            event_type TEXT NOT NULL,
            mode TEXT NOT NULL,
            temperature_c REAL,
            target_c REAL,
            simulated_heater_on INTEGER NOT NULL,
            details TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_fermenter_actions_time ON fermenter_actions(occurred_at,id);
        CREATE INDEX IF NOT EXISTS idx_fermenter_actions_fermentation ON fermenter_actions(fermentation_id,occurred_at);
        """)
        # Add nullable links in place. Existing readings and photographs remain untouched.
        for table in ("readings", "photos"):
            columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
            if "fermentation_id" not in columns:
                db.execute(f"ALTER TABLE {table} ADD COLUMN fermentation_id INTEGER REFERENCES fermentations(id)")
            db.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_fermentation ON {table}(fermentation_id)")
        db.execute("INSERT OR IGNORE INTO monitoring_control(id,active,changed_at) VALUES(1,0,?)",
                   (utc_now(),))
        db.execute("INSERT OR IGNORE INTO fermenter_settings(id,updated_at) VALUES(1,?)", (utc_now(),))
        db.execute("INSERT OR IGNORE INTO fermenter_runtime(id) VALUES(1)")


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
        session_id = active_fermentation_id(db)
        db.execute("INSERT INTO readings(captured_at,temperature_c,humidity_rh,sensor_ok,error,fermentation_id) VALUES(?,?,?,?,?,?)",
                   (utc_now(), temperature, humidity, int(error is None), error, session_id))


def add_photo(filename, error=None, analysis=None):
    analysis = analysis or {}
    with connect() as db:
        session_id = active_fermentation_id(db)
        db.execute("""INSERT INTO photos(captured_at,filename,growth_score,growth_detected,
                   analysis_json,camera_ok,error,fermentation_id) VALUES(?,?,?,?,?,?,?,?)""",
                   (utc_now(), filename, analysis.get("growth_score"), analysis.get("growth_detected"),
                    analysis.get("analysis_json"), int(error is None), error, session_id))


def active_fermentation_id(db=None):
    if db is not None:
        row = db.execute("SELECT id FROM fermentations WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1").fetchone()
        return row[0] if row else None
    with connect() as connection:
        return active_fermentation_id(connection)


def start_fermentation(fields):
    with connect() as db:
        if active_fermentation_id(db) is not None:
            raise ValueError("Ja hi ha una fermentació activa")
        started_at = utc_now()
        cursor = db.execute("""INSERT INTO fermentations(
            started_at,starter_mass_g,flour_g,water_g,flour_type,hydration_pct,
            initial_ph,initial_dough_temp_c,target_fermenter_temp_c,notes
        ) VALUES(?,?,?,?,?,?,?,?,?,?)""", (
            started_at, fields.get("starter_mass_g"), fields.get("flour_g"), fields.get("water_g"),
            fields.get("flour_type"), fields.get("hydration_pct"), fields.get("initial_ph"),
            fields.get("initial_dough_temp_c"), fields.get("target_fermenter_temp_c"), fields.get("notes")))
        db.execute("INSERT INTO events(fermentation_id,occurred_at,event_type,details) VALUES(?,?,?,?)",
                   (cursor.lastrowid, started_at, "fermentation_start", "Inici de fermentació"))
        return dict(db.execute("SELECT * FROM fermentations WHERE id=?", (cursor.lastrowid,)).fetchone())


def end_fermentation(fermentation_id):
    with connect() as db:
        ended_at = utc_now()
        updated = db.execute("UPDATE fermentations SET ended_at=? WHERE id=? AND ended_at IS NULL",
                             (ended_at, fermentation_id))
        if updated.rowcount:
            db.execute("INSERT INTO events(fermentation_id,occurred_at,event_type,details) VALUES(?,?,?,?)",
                       (fermentation_id, ended_at, "fermentation_end", "Final de fermentació"))
        row = db.execute("SELECT * FROM fermentations WHERE id=?", (fermentation_id,)).fetchone()
        return dict(row) if row else None


def add_event(fields):
    with connect() as db:
        fermentation_id = fields.get("fermentation_id") or active_fermentation_id(db)
        cursor = db.execute("""INSERT INTO events(
            fermentation_id,occurred_at,event_type,starter_mass_g,flour_g,water_g,flour_type,
            hydration_pct,ph,dough_temp_c,target_temp_c,details
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (
            fermentation_id, utc_now(), fields["event_type"], fields.get("starter_mass_g"),
            fields.get("flour_g"), fields.get("water_g"), fields.get("flour_type"),
            fields.get("hydration_pct"), fields.get("ph"), fields.get("dough_temp_c"),
            fields.get("target_temp_c"), fields.get("details")))
        return dict(db.execute("SELECT * FROM events WHERE id=?", (cursor.lastrowid,)).fetchone())


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

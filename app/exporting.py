"""Consistent, read-only ZIP export of a time-bounded Panettone Lab session."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sqlite3
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Tuple


def _utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamps must include a timezone")
    return parsed.astimezone(timezone.utc)


def _iso(value: Optional[str]) -> str:
    if not value:
        return ""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat(timespec="seconds")


def _write_csv(archive: zipfile.ZipFile, name: str, header: list[str], rows) -> None:
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(header)
    writer.writerows(rows)
    archive.writestr(name, stream.getvalue().encode("utf-8"))


def _gaps(rows, expected_seconds: int) -> list[dict]:
    times = [datetime.fromisoformat(row["captured_at"].replace("Z", "+00:00")) for row in rows]
    result = []
    threshold = expected_seconds * 1.5
    for previous, current in zip(times, times[1:]):
        seconds = (current - previous).total_seconds()
        if seconds > threshold:
            result.append({
                "from": previous.isoformat(timespec="seconds"),
                "to": current.isoformat(timespec="seconds"),
                "elapsed_seconds": round(seconds, 1),
                "expected_interval_seconds": expected_seconds,
                "estimated_missing_samples": max(1, round(seconds / expected_seconds) - 1),
            })
    return result


def list_observation_sessions(database_path: str, split_gap_seconds: int = 900) -> list[dict]:
    """Infer observation windows from long gaps; the schema has no session log."""
    db = sqlite3.connect(f"file:{Path(database_path).resolve()}?mode=ro", uri=True, timeout=15)
    try:
        timestamps = [row[0] for row in db.execute(
            "SELECT captured_at FROM readings UNION ALL SELECT captured_at FROM photos ORDER BY captured_at")]
    finally:
        db.close()
    if not timestamps:
        return []
    groups: list[list[str]] = [[timestamps[0]]]
    for value in timestamps[1:]:
        previous = datetime.fromisoformat(groups[-1][-1].replace("Z", "+00:00"))
        current = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if (current - previous).total_seconds() > split_gap_seconds:
            groups.append([value])
        else:
            groups[-1].append(value)
    result = []
    for group in groups:
        first = datetime.fromisoformat(group[0].replace("Z", "+00:00")).astimezone(timezone.utc)
        last = datetime.fromisoformat(group[-1].replace("Z", "+00:00")).astimezone(timezone.utc)
        start = first.isoformat(timespec="seconds")
        end = (last + timedelta(seconds=1)).isoformat(timespec="seconds")
        session_id = "obs-" + first.strftime("%Y%m%dT%H%M%SZ")
        result.append({"id": session_id, "start": start, "end_exclusive": end,
                       "last_observation": last.isoformat(timespec="seconds"),
                       "inferred": True, "split_gap_seconds": split_gap_seconds})
    return result


def get_observation_session(database_path: str, session_id: str) -> Optional[dict]:
    return next((item for item in list_observation_sessions(database_path) if item["id"] == session_id), None)


def build_session_zip(database_path: str, photo_dir: str, start: str, end: str,
                      app_version: str = "unknown", timezone_name: str = "Europe/Madrid",
                      sensor_interval_seconds: int = 30,
                      photo_interval_seconds: int = 120,
                      supplied_session_id: Optional[str] = None) -> Tuple[io.BytesIO, dict]:
    """Create a ZIP from a SQLite backup and immutable photo files.

    `start` is inclusive and `end` is exclusive. The source DB is never modified.
    Returned report is suitable for CLI verification and the authenticated API.
    """
    start_dt, end_dt = _utc(start), _utc(end)
    if end_dt <= start_dt:
        raise ValueError("end must be later than start")
    start_utc = start_dt.isoformat(timespec="seconds")
    end_utc = end_dt.isoformat(timespec="seconds")
    session_id = supplied_session_id or ("session-" + start_dt.strftime("%Y%m%dT%H%M%SZ") + "-" + end_dt.strftime("%Y%m%dT%H%M%SZ"))

    with tempfile.TemporaryDirectory(prefix="panettone-export-") as temp_dir:
        snapshot = os.path.join(temp_dir, "snapshot.sqlite")
        source = sqlite3.connect(database_path, timeout=30)
        destination = sqlite3.connect(snapshot)
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()

        db = sqlite3.connect(snapshot)
        db.row_factory = sqlite3.Row
        try:
            readings = [dict(row) for row in db.execute(
                "SELECT * FROM readings WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at, id",
                (start_utc, end_utc))]
            photos = [dict(row) for row in db.execute(
                "SELECT * FROM photos WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at, id",
                (start_utc, end_utc))]
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            events = []
            if "events" in tables:
                columns = {row[1] for row in db.execute("PRAGMA table_info(events)")}
                time_column = next((name for name in ("occurred_at", "captured_at", "timestamp", "created_at") if name in columns), None)
                if time_column:
                    allowed = [name for name in ("id", time_column, "event_type", "type", "title", "details", "note", "session_id", "fermentation_id", "starter_mass_g", "flour_g", "water_g", "flour_type", "hydration_pct", "ph", "dough_temp_c", "target_temp_c") if name in columns]
                    events = [dict(row) for row in db.execute(
                        f'SELECT {", ".join(chr(34) + name + chr(34) for name in allowed)} FROM events WHERE "{time_column}" >= ? AND "{time_column}" < ? ORDER BY "{time_column}"',
                        (start_utc, end_utc))]
            controls = [dict(row) for row in db.execute("SELECT * FROM monitoring_control ORDER BY id")] if "monitoring_control" in tables else []
        finally:
            db.close()

        # Keep the archive on temporary storage instead of holding every
        # original photo in Raspberry Pi memory.
        archive_stream = tempfile.TemporaryFile(mode="w+b")
        photo_root = Path(photo_dir).resolve()
        photo_rows = []
        exported_paths = []
        timestamp_checks = []
        for row in photos:
            filename = row.get("filename") or ""
            safe_name = Path(filename).name if filename else ""
            source_path = (photo_root / safe_name).resolve() if safe_name else None
            exists = bool(source_path and source_path.parent == photo_root and source_path.is_file())
            status = "ok" if row.get("camera_ok") and exists else ("missing_file" if row.get("camera_ok") else "capture_error")
            relative_path = f"photos/{safe_name}" if exists else ""
            photo_rows.append([_iso(row.get("captured_at")), safe_name, relative_path, session_id,
                               "tapo-c210@10.85.3.237", row.get("fermentation_id", ""), status, row.get("error") or ""])
            if exists:
                exported_paths.append((source_path, relative_path))
                # Filenames are generated in local time immediately before capture. Compare
                # their parsed Europe/Madrid time with the UTC DB timestamp, reporting drift.
                try:
                    local_stamp = datetime.strptime(Path(safe_name).stem, "%Y%m%d-%H%M%S").replace(
                        tzinfo=__import__("zoneinfo").ZoneInfo(timezone_name))
                    db_stamp = datetime.fromisoformat(row["captured_at"].replace("Z", "+00:00"))
                    timestamp_checks.append(abs((local_stamp.astimezone(timezone.utc) - db_stamp.astimezone(timezone.utc)).total_seconds()))
                except (ValueError, KeyError):
                    pass

        reading_rows = [[_iso(row.get("captured_at")), row.get("temperature_c"), row.get("humidity_rh"),
                         "shelly-plus-uni", "ok" if row.get("sensor_ok") else "error", row.get("error") or "",
                         row.get("fermentation_id", "")] for row in readings]
        event_header = list(events[0].keys()) if events else ["timestamp", "event_type", "details"]
        event_rows = [[_iso(row.get(key)) if key in ("captured_at", "occurred_at", "timestamp", "created_at") else row.get(key, "")
                       for key in event_header] for row in events]
        reading_gaps = _gaps(readings, sensor_interval_seconds)
        photo_gaps = _gaps([row for row in photos if row.get("camera_ok")], photo_interval_seconds)

        metadata = {
            "session_id": session_id,
            "session_id_source": "caller_supplied" if supplied_session_id else "generated_from_export_time_window",
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "requested_window_local": {"start_inclusive": start_dt.astimezone(__import__("zoneinfo").ZoneInfo(timezone_name)).isoformat(),
                                       "end_exclusive": end_dt.astimezone(__import__("zoneinfo").ZoneInfo(timezone_name)).isoformat()},
            "data_window_utc": {"start_inclusive": start_utc, "end_exclusive": end_utc},
            "first_reading": _iso(readings[0]["captured_at"]) if readings else None,
            "last_reading": _iso(readings[-1]["captured_at"]) if readings else None,
            "first_photo_record": _iso(photos[0]["captured_at"]) if photos else None,
            "last_photo_record": _iso(photos[-1]["captured_at"]) if photos else None,
            "first_exported_photo": next((_iso(row["captured_at"]) for row in photos if row.get("filename") and row.get("camera_ok") and (photo_root / Path(row["filename"]).name).is_file()), None),
            "last_exported_photo": next((_iso(row["captured_at"]) for row in reversed(photos) if row.get("filename") and row.get("camera_ok") and (photo_root / Path(row["filename"]).name).is_file()), None),
            "timezone": timezone_name,
            "application_version": app_version,
            "camera": {"model": "Tapo C210", "address": "10.85.3.237", "stream": "/stream1"},
            "sensor": {"model": "Shelly Plus UNI", "address": "10.85.3.202", "temperature_key": "temperature:100.tC", "humidity_key": "humidity:100.rh", "sensor_id_in_database": False},
            "units": {"temperature": "°C", "relative_humidity": "%"},
            "expected_sampling_seconds": {"readings": sensor_interval_seconds, "photos": photo_interval_seconds},
            "counts": {"reading_records": len(readings), "reading_errors": sum(not bool(r.get("sensor_ok")) for r in readings),
                       "photo_records": len(photos), "photo_errors": sum(not bool(r.get("camera_ok")) for r in photos),
                       "photo_files_exported": len(exported_paths), "events": len(events)},
            "fermentation_ids_in_window": sorted({str(row.get("fermentation_id")) for row in readings + photos + events
                                                   if row.get("fermentation_id") is not None}),
            "timestamp_alignment": {"filename_time_basis": timezone_name,
                                    "filename_to_database_abs_delta_seconds_max": max(timestamp_checks) if timestamp_checks else None,
                                    "filename_timestamp_checks": len(timestamp_checks)},
            "monitoring_control_current_snapshot": controls,
            "incidents": {"reading_gaps": reading_gaps, "photo_gaps": photo_gaps,
                          "failed_readings": [{"timestamp": _iso(r["captured_at"]), "error": r.get("error")} for r in readings if not r.get("sensor_ok")],
                          "failed_photos": [{"timestamp": _iso(r["captured_at"]), "error": r.get("error")} for r in photos if not r.get("camera_ok")],
                          "successful_photos_missing_files": [{"timestamp": _iso(r["captured_at"]), "filename": r.get("filename")} for r in photos if r.get("camera_ok") and not (r.get("filename") and (photo_root / Path(r["filename"]).name).is_file())],
            },
            "events_note": "The current database has no event log; no events were inferred.",
        }

        with zipfile.ZipFile(archive_stream, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            _write_csv(archive, "readings.csv",
                       ["timestamp", "temperature_c", "humidity_rh", "sensor_id", "quality", "error", "fermentation_id"], reading_rows)
            _write_csv(archive, "photos.csv",
                       ["timestamp", "filename", "path", "session_id", "camera_id", "fermentation_id", "capture_status", "error"], photo_rows)
            _write_csv(archive, "events.csv", event_header, event_rows)
            archive.writestr("metadata.json", json.dumps(metadata, ensure_ascii=False, indent=2).encode("utf-8"))
            for source_path, relative_path in exported_paths:
                archive.write(source_path, relative_path)
        archive_stream.seek(0)
    return archive_stream, metadata


def main() -> None:
    parser = argparse.ArgumentParser(description="Export Panettone Lab readings and photos into a ZIP")
    parser.add_argument("--database", default="/data/panettone.db")
    parser.add_argument("--photos", default="/data/photos")
    parser.add_argument("--start", required=True, help="ISO 8601 inclusive, with timezone")
    parser.add_argument("--end", required=True, help="ISO 8601 exclusive, with timezone")
    parser.add_argument("--version", default="0.4.0")
    parser.add_argument("--timezone", default="Europe/Madrid")
    parser.add_argument("--sensor-interval", type=int, default=30)
    parser.add_argument("--photo-interval", type=int, default=120)
    parser.add_argument("--session-id")
    args = parser.parse_args()
    stream, metadata = build_session_zip(args.database, args.photos, args.start, args.end,
                                         args.version, args.timezone, args.sensor_interval,
                                         args.photo_interval, args.session_id)
    stream.seek(0, os.SEEK_END)
    archive_bytes = stream.tell()
    stream.seek(0)
    while chunk := stream.read(1024 * 1024):
        sys.stdout.buffer.write(chunk)
    stream.close()
    print(json.dumps({"bytes": archive_bytes, "counts": metadata["counts"],
                      "first_reading": metadata["first_reading"], "last_reading": metadata["last_reading"],
                      "first_photo_record": metadata["first_photo_record"], "last_photo_record": metadata["last_photo_record"],
                      "timestamp_alignment": metadata["timestamp_alignment"]}, ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":
    main()

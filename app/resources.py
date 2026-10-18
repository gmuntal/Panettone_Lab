"""Read-only Raspberry Pi and application storage measurements."""
import os
import sqlite3
from pathlib import Path
from datetime import datetime, timezone


def _disk(path):
    try:
        stat = os.statvfs(path)
        total = stat.f_blocks * stat.f_frsize
        free = stat.f_bavail * stat.f_frsize
        return {"total_bytes": total, "available_bytes": free,
                "used_bytes": max(0, total - free),
                "used_percent": round(100 * (total - free) / total, 1) if total else None}
    except OSError:
        return None


def _memory():
    values = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, raw = line.split(":", 1)
            values[key] = int(raw.strip().split()[0]) * 1024
        total = values.get("MemTotal")
        available = values.get("MemAvailable")
        result = {"total_bytes": total, "available_bytes": available,
                  "used_bytes": total - available if total is not None and available is not None else None}
        result["used_percent"] = round(100 * result["used_bytes"] / total, 1) if total and result["used_bytes"] is not None else None
    except (OSError, ValueError, IndexError):
        result = {"total_bytes": None, "available_bytes": None, "used_bytes": None, "used_percent": None}
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                result["process_rss_bytes"] = int(line.split()[1]) * 1024
                break
    except (OSError, ValueError, IndexError):
        pass
    result.setdefault("process_rss_bytes", None)
    return result


def _directory_bytes(directory):
    total = 0
    try:
        root = Path(directory)
        if not root.exists():
            return 0
        for candidate in root.rglob("*"):
            try:
                if candidate.is_file() and not candidate.is_symlink():
                    total += candidate.stat().st_size
            except OSError:
                continue
        return total
    except OSError:
        return None


def resource_snapshot(database_path, photo_dir, data_dir):
    data_disk = _disk(data_dir)
    root_disk = _disk("/")
    photo_bytes = photo_count = db_bytes = None
    service_status = {"application": "en marxa", "seguiment": "desconegut",
                      "Shelly": "sense lectura", "càmera": "sense captura"}
    try:
        with sqlite3.connect(f"file:{Path(database_path).resolve()}?mode=ro", uri=True, timeout=5) as db:
            photo_count = db.execute("SELECT count(*) FROM photos WHERE camera_ok=1 AND filename<>''").fetchone()[0]
            photo_rows = db.execute("SELECT filename FROM photos WHERE camera_ok=1 AND filename<>''").fetchall()
            control = db.execute("SELECT active FROM monitoring_control WHERE id=1").fetchone()
            reading = db.execute("SELECT captured_at,sensor_ok FROM readings ORDER BY captured_at DESC,id DESC LIMIT 1").fetchone()
            photo = db.execute("SELECT captured_at,camera_ok FROM photos ORDER BY captured_at DESC,id DESC LIMIT 1").fetchone()
        if control:
            service_status["seguiment"] = "actiu" if control[0] else "aturat"
        now = datetime.now(timezone.utc)
        if reading:
            age = (now - datetime.fromisoformat(reading[0].replace("Z", "+00:00"))).total_seconds()
            service_status["Shelly"] = "connectat" if reading[1] and 0 <= age <= 75 else "lectura obsoleta o amb error"
        if photo:
            age = (now - datetime.fromisoformat(photo[0].replace("Z", "+00:00"))).total_seconds()
            service_status["càmera"] = "connectada" if photo[1] and 0 <= age <= 3 * 120 else "captura obsoleta o amb error"
        root = Path(photo_dir).resolve()
        photo_bytes = 0
        for (filename,) in photo_rows:
            candidate = (root / Path(filename).name).resolve()
            if candidate.parent == root:
                try:
                    photo_bytes += candidate.stat().st_size
                except OSError:
                    continue
        db_bytes = sum(path.stat().st_size for path in (Path(database_path), Path(str(database_path) + "-wal"), Path(str(database_path) + "-shm")) if path.exists())
    except (OSError, sqlite3.Error):
        photo_bytes = photo_count = db_bytes = None
    temp_bytes = 0
    for candidate in Path("/tmp").glob("panettone-*"):
        try:
            if candidate.is_file():
                temp_bytes += candidate.stat().st_size
            elif candidate.is_dir():
                temp_bytes += sum(p.stat().st_size for p in candidate.rglob("*") if p.is_file())
        except OSError:
            continue
    archives_bytes = _directory_bytes(Path(data_dir) / "archives")
    backup_bytes = _directory_bytes(Path(data_dir) / "backups")
    return {"system": {"root_disk": root_disk, "data_disk": data_disk,
                       "memory": _memory(), "services": service_status},
            "application": {"photos_bytes": photo_bytes, "photo_count": photo_count,
                            "sqlite_bytes": db_bytes, "archives_bytes": archives_bytes,
                            "backup_bytes": backup_bytes, "logs_bytes": None,
                            "temporary_bytes": temp_bytes}}

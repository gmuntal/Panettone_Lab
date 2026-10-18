"""Preview and explicitly confirmed photo compaction for finished fermentations."""
import json
import os
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from .database import settings, utc_now
from .exporting import build_session_zip

SAMPLE_MINUTES = (10, 15, 30, 60)


def _photo_size(photo_dir, filename):
    if not filename:
        return 0
    root = Path(photo_dir).resolve()
    candidate = (root / Path(filename).name).resolve()
    if candidate.parent != root:
        return 0
    try:
        return candidate.stat().st_size
    except OSError:
        return 0


def session_storage(database_path, photo_dir):
    db = sqlite3.connect(f"file:{Path(database_path).resolve()}?mode=ro", uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute("""SELECT f.id,f.started_at,f.ended_at,f.archived_at,f.archive_filename,
                    f.archive_sample_minutes,f.archive_saved_bytes,count(p.id) photo_count,
                    coalesce(sum(CASE WHEN p.camera_ok=1 AND p.filename<>'' THEN 1 ELSE 0 END),0) available_photos
                    FROM fermentations f LEFT JOIN photos p ON p.fermentation_id=f.id
                    GROUP BY f.id ORDER BY f.started_at DESC""").fetchall()
        results = []
        for row in rows:
            photos = db.execute("SELECT filename FROM photos WHERE fermentation_id=? AND camera_ok=1", (row["id"],)).fetchall()
            bytes_used = sum(_photo_size(photo_dir, photo["filename"]) for photo in photos)
            item = dict(row)
            archive_bytes = 0
            if item.get("archive_filename"):
                try:
                    archive_bytes = ((Path(settings.data_dir) / "archives" / Path(item["archive_filename"]).name).stat().st_size)
                except OSError:
                    pass
            item.update(photo_bytes=bytes_used, archive_bytes=archive_bytes,
                        status="activa" if not item["ended_at"] else "arxivada" if item["archived_at"] else "finalitzada")
            results.append(item)
        return results
    finally:
        db.close()


def preview(database_path, photo_dir, fermentation_id, sample_minutes=30):
    if sample_minutes not in SAMPLE_MINUTES:
        raise ValueError("El mostreig ha de ser 10, 15, 30 o 60 minuts")
    db = sqlite3.connect(f"file:{Path(database_path).resolve()}?mode=ro", uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        fermentation = db.execute("SELECT * FROM fermentations WHERE id=?", (fermentation_id,)).fetchone()
        if not fermentation:
            raise LookupError("Fermentació no trobada")
        if not fermentation["ended_at"]:
            raise ValueError("No es poden arxivar fermentacions actives")
        photos = [dict(row) for row in db.execute("""SELECT id,captured_at,filename,camera_ok,growth_score,
                        analysis_json,important,archived_at,archived_filename FROM photos
                        WHERE fermentation_id=? ORDER BY captured_at,id""", (fermentation_id,))]
        cache_rows = db.execute("SELECT ve.photo_id,ve.data FROM visual_estimates ve JOIN photos p ON p.id=ve.photo_id WHERE ve.fermentation_id=? ORDER BY p.captured_at,p.id", (fermentation_id,)).fetchall()
        calibration = db.execute("SELECT data FROM visual_calibrations WHERE fermentation_id=? AND active=1 ORDER BY id DESC LIMIT 1", (fermentation_id,)).fetchone()
    except sqlite3.OperationalError:
        # Older databases may not yet have the visual analysis tables.
        db.close()
        db = sqlite3.connect(f"file:{Path(database_path).resolve()}?mode=ro", uri=True, timeout=10)
        db.row_factory = sqlite3.Row
        fermentation = db.execute("SELECT * FROM fermentations WHERE id=?", (fermentation_id,)).fetchone()
        if not fermentation:
            raise LookupError("Fermentació no trobada")
        if not fermentation["ended_at"]:
            raise ValueError("No es poden arxivar fermentacions actives")
        photos = [dict(row) for row in db.execute("SELECT id,captured_at,filename,camera_ok,growth_score,analysis_json,important,archived_at,archived_filename FROM photos WHERE fermentation_id=? ORDER BY captured_at,id", (fermentation_id,))]
        cache_rows, calibration = [], None
    finally:
        db.close()

    available = [p for p in photos if p["camera_ok"] and p["filename"] and not p["archived_at"]]
    keep = {}
    def require(photo, reason):
        if photo:
            keep.setdefault(photo["id"], set()).add(reason)
    if available:
        require(available[0], "Fotografia inicial")
        require(available[-1], "Fotografia final")
        for photo in available:
            if photo["important"]:
                require(photo, "Marcada com important")
        try:
            if calibration:
                calibration_data = json.loads(calibration["data"])
                require(next((p for p in available if p["id"] == calibration_data.get("photo_id")), None), "Referència calibrada")
        except (TypeError, ValueError, KeyError):
            pass
        estimates = []
        for raw in cache_rows or []:
            try:
                item = json.loads(raw["data"])
                if item.get("valid") and isinstance(item.get("percent"), (int, float)):
                    estimates.append((item["percent"], item, raw["photo_id"]))
            except (TypeError, ValueError):
                continue
        if estimates:
            max_photo_id = max(estimates, key=lambda item: item[0])[2]
            require(next((p for p in available if p["id"] == max_photo_id), None), "Màxim creixement")
            for threshold, label in ((100, "Primera duplicació"), (200, "Primera triplicació")):
                crossing = next((item for item in estimates if item[0] >= threshold), None)
                if crossing:
                    require(next((p for p in available if p["id"] == crossing[2]), None), label)
    cutoff_seconds = sample_minutes * 60
    sampled = []
    if available:
        start = datetime.fromisoformat(available[0]["captured_at"].replace("Z", "+00:00"))
        next_cutoff = 0
        for photo in available:
            current = datetime.fromisoformat(photo["captured_at"].replace("Z", "+00:00"))
            elapsed = (current - start).total_seconds()
            if elapsed >= next_cutoff:
                sampled.append(photo)
                next_cutoff = elapsed + cutoff_seconds
    for photo in sampled:
        require(photo, f"Mostreig cada {sample_minutes} min")

    total_bytes = 0
    for photo in photos:
        photo["size_bytes"] = _photo_size(photo_dir, photo["filename"]) if photo["camera_ok"] else 0
        total_bytes += photo["size_bytes"]
        photo["keep"] = photo["id"] in keep
        photo["required_reasons"] = sorted(keep.get(photo["id"], ()))
        photo["photo_url"] = f"/photos/{Path(photo['filename']).name}" if photo["filename"] and photo["camera_ok"] else None
    kept_bytes = sum(p["size_bytes"] for p in photos if p["id"] in keep)
    removable = [p for p in photos if p["camera_ok"] and p["filename"] and p["id"] not in keep]
    return {"fermentation": dict(fermentation), "sample_minutes": sample_minutes,
            "photos": photos, "original_count": len(available), "kept_count": len(keep),
            "removed_count": len(removable), "original_bytes": total_bytes,
            "kept_bytes": kept_bytes, "estimated_savings_bytes": total_bytes - kept_bytes,
            "must_keep_ids": sorted(keep)}


def mark_important(database_path, fermentation_id, photo_id, important):
    if not isinstance(important, bool):
        raise ValueError("important ha de ser booleà")
    with sqlite3.connect(database_path, timeout=10) as db:
        row = db.execute("SELECT id FROM photos WHERE id=? AND fermentation_id=? AND camera_ok=1 AND filename<>''", (photo_id, fermentation_id)).fetchone()
        if not row:
            raise LookupError("Fotografia no trobada o ja arxivada")
        db.execute("UPDATE photos SET important=? WHERE id=?", (int(important), photo_id))


def archive(database_path, photo_dir, data_dir, fermentation_id, sample_minutes, keep_photo_ids,
            confirmed_export_download):
    if confirmed_export_download is not True:
        raise ValueError("Abans d’arxivar, descarrega i comprova el ZIP complet")
    if not isinstance(keep_photo_ids, list) or any(type(value) is not int for value in keep_photo_ids):
        raise ValueError("La selecció de fotografies no és vàlida")
    current = preview(database_path, photo_dir, fermentation_id, sample_minutes)
    if current["fermentation"]["archived_at"]:
        raise ValueError("Aquesta fermentació ja està arxivada")
    ids = set(keep_photo_ids) | set(current["must_keep_ids"])
    all_ids = {p["id"] for p in current["photos"] if p["camera_ok"] and p["filename"]}
    if not ids.issubset(all_ids):
        raise ValueError("La selecció conté fotografies d’una altra fermentació")
    removed = [p for p in current["photos"] if p["id"] in all_ids - ids]
    start = current["fermentation"]["started_at"]
    ended = current["fermentation"]["ended_at"]
    started_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    ended_dt = datetime.fromisoformat(ended.replace("Z", "+00:00"))
    if ended_dt <= started_dt:
        raise ValueError("Interval de fermentació invàlid")
    archive_dir = Path(data_dir) / "archives"
    archive_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_name = f"panettone_lab_fermentacio_{fermentation_id}_{stamp}.zip"
    archive_path = archive_dir / archive_name
    stage = Path(photo_dir) / f".archive-stage-{fermentation_id}"
    if stage.exists():
        raise RuntimeError("Hi ha un arxivament anterior pendent de recuperar")
    stream, _metadata = build_session_zip(database_path, photo_dir,
        started_dt.isoformat(timespec="seconds"), (ended_dt.replace(microsecond=0).isoformat(timespec="seconds")),
        supplied_session_id=f"fermentation-{fermentation_id}", temp_dir=data_dir)
    try:
        with archive_path.open("wb") as output:
            shutil.copyfileobj(stream, output)
        with zipfile.ZipFile(archive_path) as check:
            if check.testzip() is not None:
                raise RuntimeError("La verificació CRC del ZIP ha fallat")
            names = set(check.namelist())
            if not {"readings.csv", "photos.csv", "events.csv", "metadata.json"}.issubset(names):
                raise RuntimeError("El ZIP no conté tots els índexs necessaris")
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise
    finally:
        stream.close()

    moved = []
    committed = False
    try:
        stage.mkdir(mode=0o700)
        root = Path(photo_dir).resolve()
        for photo in removed:
            source = (root / Path(photo["filename"]).name).resolve()
            if source.parent != root or not source.is_file():
                continue
            destination = stage / source.name
            os.replace(source, destination)
            moved.append((source, destination, photo))
        with sqlite3.connect(database_path, timeout=15) as db:
            db.execute("PRAGMA foreign_keys=ON")
            for source, _destination, photo in moved:
                db.execute("UPDATE photos SET archived_filename=?,filename='',archived_at=? WHERE id=?",
                           (source.name, utc_now(), photo["id"]))
            db.execute("UPDATE photos SET important=1 WHERE id IN (%s)" % ",".join("?" for _ in ids), tuple(ids)) if ids else None
            cursor = db.execute("UPDATE fermentations SET archived_at=?,archive_filename=?,archive_sample_minutes=?,archive_saved_bytes=? WHERE id=? AND ended_at IS NOT NULL AND archived_at IS NULL",
                       (utc_now(), archive_name, sample_minutes, sum(item["size_bytes"] for item in removed), fermentation_id))
            if cursor.rowcount != 1:
                raise RuntimeError("No s’ha pogut marcar la fermentació com arxivada")
        committed = True
        # The original bytes remain in the verified ZIP; the staged originals
        # are only a rollback window and are removed after the DB commit.
        try:
            shutil.rmtree(stage)
        except OSError:
            pass  # recover_staging() will clean it after restart.
    except Exception:
        if committed:
            raise
        for source, destination, _photo in reversed(moved):
            if destination.exists() and not source.exists():
                os.replace(destination, source)
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
        archive_path.unlink(missing_ok=True)
        raise
    return {"archive_filename": archive_name, "archive_bytes": archive_path.stat().st_size,
            "removed_count": len(moved), "kept_count": len(all_ids) - len(moved),
            "estimated_savings_bytes": sum(item[2]["size_bytes"] for item in moved),
            "archive_path": str(archive_path)}


def recover_staging(database_path, photo_dir):
    """Restore uncommitted staging directories or purge already committed ones."""
    root = Path(photo_dir)
    for stage in root.glob(".archive-stage-*"):
        try:
            fermentation_id = int(stage.name.rsplit("-", 1)[1])
        except ValueError:
            continue
        with sqlite3.connect(database_path, timeout=10) as db:
            row = db.execute("SELECT archived_at FROM fermentations WHERE id=?", (fermentation_id,)).fetchone()
        if row and row[0]:
            shutil.rmtree(stage, ignore_errors=True)
        else:
            for candidate in stage.iterdir():
                destination = root / candidate.name
                if candidate.is_file() and not destination.exists():
                    os.replace(candidate, destination)
            shutil.rmtree(stage, ignore_errors=True)

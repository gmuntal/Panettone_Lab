import os
import json
import sqlite3
import tempfile
import threading
import hmac
import logging
from datetime import datetime, timezone
from collections import deque
import time
from pathlib import Path
from io import BytesIO
from functools import wraps

from flask import Flask, abort, jsonify, redirect, render_template, request, send_file, send_from_directory, session, url_for

from .config import settings, validate_settings
from .database import (growth_config, growth_history, init_db, latest_analyzed_photo,
                       monitoring_state, set_monitoring_active,
                       latest_state, recent_photos, recent_readings, save_growth_roi,
                       set_growth_baseline, update_photo_analysis, active_fermentation_id,
                       add_event, end_fermentation, start_fermentation)
from .devices import capture_photo
from .exporting import build_session_zip, get_observation_session, list_observation_sessions
from .growth_detection import analyze_image
from .scheduler import start_workers

APP_VERSION = "0.4.0"
log = logging.getLogger(__name__)
_api_rate_lock = threading.Lock()
_api_rate_windows = {}


def create_app(start_background=False):
    validate_settings()
    init_db()
    app = Flask(__name__)
    app.secret_key = settings.app_secret_key
    app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                      SESSION_COOKIE_SECURE=settings.session_cookie_secure, MAX_CONTENT_LENGTH=1024 * 1024)
    app.extensions["workers_stop"] = start_workers() if start_background else threading.Event()

    @app.after_request
    def log_api_access(response):
        if request.path.startswith("/api/v1/"):
            log.info("readonly_api method=%s path=%s status=%s remote=%s",
                     request.method, request.path, response.status_code, request.remote_addr or "unknown")
            response.headers["Cache-Control"] = "no-store"
        return response

    def login_required(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            if not session.get("authenticated"):
                if request.path.startswith("/api/"):
                    return jsonify({"error": "cal iniciar sessió"}), 401
                return redirect(url_for("login", next=request.path))
            return fn(*args, **kwargs)
        return wrapped

    def readonly_api_required(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            token = settings.readonly_api_token
            supplied = request.headers.get("Authorization", "")
            if not token or not supplied.startswith("Bearer ") or not hmac.compare_digest(supplied[7:], token):
                return jsonify({"error": "credencial de consulta invàlida o no configurada"}), 401
            now = time.monotonic(); key = request.remote_addr or "unknown"
            with _api_rate_lock:
                window = _api_rate_windows.setdefault(key, deque())
                while window and now - window[0] > 60:
                    window.popleft()
                if len(window) >= 120:
                    return jsonify({"error": "massa peticions; espera un minut"}), 429
                window.append(now)
                if len(_api_rate_windows) > 512:
                    for address in list(_api_rate_windows)[:128]:
                        _api_rate_windows.pop(address, None)
            return fn(*args, **kwargs)
        return wrapped

    def utc_bound(param):
        value = request.args.get(param)
        if value is None:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            abort(400, description=f"{param} ha de ser una data ISO 8601")
        if parsed.tzinfo is None:
            abort(400, description=f"{param} ha d'incloure zona horària")
        return parsed.astimezone(timezone.utc).isoformat(timespec="seconds")

    def page_params():
        try:
            limit = int(request.args.get("limit", "200"))
            offset = int(request.args.get("offset", "0"))
        except ValueError:
            abort(400, description="limit i offset han de ser enters")
        if limit < 1 or limit > 1000 or offset < 0:
            abort(400, description="limit ha de ser 1..1000 i offset >= 0")
        return limit, offset

    def fermentation_filter():
        value = request.args.get("fermentation_id")
        if value is None:
            return None
        try:
            result = int(value)
        except ValueError:
            abort(400, description="fermentation_id ha de ser un enter")
        if result < 1:
            abort(400, description="fermentation_id ha de ser positiu")
        return result

    def paginated(rows, limit, offset):
        has_more = len(rows) > limit
        rows = rows[:limit]
        return {"items": rows, "limit": limit, "offset": offset,
                "next_offset": offset + limit if has_more else None}

    def query_range():
        start, end = utc_bound("start"), utc_bound("end")
        if start and end and end <= start:
            abort(400, description="end ha de ser posterior a start")
        return start, end

    def read_rows(sql, params):
        db = sqlite3.connect(Path(settings.database_path).resolve().as_uri() + "?mode=ro", uri=True, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            return [dict(row) for row in db.execute(sql, params)]
        finally:
            db.close()

    def add_range_clauses(column, start, end):
        clauses, params = [], []
        if start:
            clauses.append(f"{column} >= ?"); params.append(start)
        if end:
            clauses.append(f"{column} < ?"); params.append(end)
        return (" WHERE " + " AND ".join(clauses) if clauses else ""), params

    @app.get("/login")
    def login():
        return render_template("login.html", error=None)

    @app.post("/login")
    def login_post():
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        if username == settings.auth_username and password == settings.auth_password:
            session.clear()
            session["authenticated"] = True
            destination = request.args.get("next", "/")
            if not destination.startswith("/") or destination.startswith("//"):
                destination = "/"
            return redirect(destination)
        return render_template("login.html", error="Usuari o contrasenya incorrectes"), 401

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    @app.get("/healthz")
    def healthz():
        return jsonify({"status": "ok"})

    @app.get("/manifest.webmanifest")
    def manifest():
        return send_from_directory(app.static_folder, "manifest.webmanifest", mimetype="application/manifest+json")

    @app.get("/service-worker.js")
    def service_worker():
        response = send_from_directory(app.static_folder, "service-worker.js", mimetype="application/javascript")
        response.headers["Service-Worker-Allowed"] = "/"
        return response

    @app.get("/")
    @login_required
    def dashboard():
        return render_template("dashboard.html")

    @app.get("/api/state")
    @login_required
    def state():
        return jsonify(latest_state())

    @app.get("/api/monitoring")
    @login_required
    def monitoring():
        return jsonify(monitoring_state())

    @app.post("/api/monitoring")
    @login_required
    def set_monitoring():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or not isinstance(payload.get("active"), bool):
            abort(400)
        return jsonify(set_monitoring_active(payload["active"]))

    @app.get("/api/readings")
    @login_required
    def readings():
        try:
            hours = min(24 * 30, max(1, int(request.args.get("hours", "24"))))
        except ValueError:
            abort(400)
        return jsonify(recent_readings(hours))

    @app.get("/api/photos")
    @login_required
    def photos():
        limit = request.args.get("limit", default=48, type=int)
        if limit is None:
            abort(400)
        return jsonify(recent_photos(min(500, max(1, limit))))

    def observation_session_or_404(session_id):
        item = get_observation_session(settings.database_path, session_id)
        if item is None:
            abort(404)
        return item

    @app.get("/api/sessions")
    @login_required
    def sessions():
        result = list_observation_sessions(settings.database_path)
        db = sqlite3.connect(f"file:{settings.database_path}?mode=ro", uri=True, timeout=15)
        try:
            for item in result:
                start, end = item["start"], item["end_exclusive"]
                item["counts"] = {
                    "readings": db.execute("SELECT count(*) FROM readings WHERE captured_at >= ? AND captured_at < ?", (start, end)).fetchone()[0],
                    "photos": db.execute("SELECT count(*) FROM photos WHERE captured_at >= ? AND captured_at < ?", (start, end)).fetchone()[0],
                }
        finally:
            db.close()
        return jsonify({"sessions": result, "session_detection": "inferred from observation gaps; the database does not record fermentation session start/stop events"})

    @app.get("/api/sessions/<session_id>/readings")
    @login_required
    def session_readings(session_id):
        item = observation_session_or_404(session_id)
        db = sqlite3.connect(f"file:{settings.database_path}?mode=ro", uri=True, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            rows = [dict(row) for row in db.execute(
                "SELECT * FROM readings WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at, id",
                (item["start"], item["end_exclusive"]))]
        finally:
            db.close()
        return jsonify(rows)

    @app.get("/api/sessions/<session_id>/photos")
    @login_required
    def session_photos(session_id):
        item = observation_session_or_404(session_id)
        db = sqlite3.connect(f"file:{settings.database_path}?mode=ro", uri=True, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            rows = [dict(row) for row in db.execute(
                "SELECT * FROM photos WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at, id",
                (item["start"], item["end_exclusive"]))]
        finally:
            db.close()
        for row in rows:
            row["photo_url"] = f"/photos/{row['filename']}" if row.get("filename") and row.get("camera_ok") else None
        return jsonify(rows)

    @app.get("/api/sessions/<session_id>/export")
    @login_required
    def session_export(session_id):
        item = observation_session_or_404(session_id)
        archive, _metadata = build_session_zip(
            settings.database_path, settings.photo_dir, item["start"], item["end_exclusive"],
            app_version=APP_VERSION, timezone_name="Europe/Madrid",
            sensor_interval_seconds=settings.sensor_interval_seconds,
            photo_interval_seconds=settings.photo_interval_seconds,
            supplied_session_id=session_id)
        response = send_file(archive, mimetype="application/zip", as_attachment=True,
                             download_name=f"panettone_lab_{session_id}.zip", max_age=0)
        response.headers["Cache-Control"] = "no-store"
        return response

    def optional_number(payload, key, minimum=None, maximum=None):
        value = payload.get(key)
        if value in (None, ""):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            abort(400, description=f"{key} ha de ser numèric")
        if minimum is not None and number < minimum or maximum is not None and number > maximum:
            abort(400, description=f"{key} fora de rang")
        return number

    @app.get("/api/fermentations")
    @login_required
    def web_fermentations():
        rows = read_rows("SELECT * FROM fermentations ORDER BY started_at DESC LIMIT 100", ())
        return jsonify({"items": rows, "active": next((row for row in rows if row["ended_at"] is None), None)})

    @app.post("/api/fermentations")
    @login_required
    def web_start_fermentation():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            abort(400)
        fields = {
            "starter_mass_g": optional_number(payload, "starter_mass_g", 0, 100000),
            "flour_g": optional_number(payload, "flour_g", 0, 100000),
            "water_g": optional_number(payload, "water_g", 0, 100000),
            "flour_type": str(payload.get("flour_type", ""))[:120] or None,
            "hydration_pct": optional_number(payload, "hydration_pct", 0, 500),
            "initial_ph": optional_number(payload, "initial_ph", 0, 14),
            "initial_dough_temp_c": optional_number(payload, "initial_dough_temp_c", -20, 100),
            "target_fermenter_temp_c": optional_number(payload, "target_fermenter_temp_c", -20, 100),
            "notes": str(payload.get("notes", ""))[:2000] or None,
        }
        try:
            result = start_fermentation(fields)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 409
        return jsonify(result), 201

    @app.post("/api/fermentations/<int:fermentation_id>/end")
    @login_required
    def web_end_fermentation(fermentation_id):
        result = end_fermentation(fermentation_id)
        return (jsonify(result), 200) if result else (jsonify({"error": "fermentació no trobada"}), 404)

    @app.post("/api/events")
    @login_required
    def web_add_event():
        payload = request.get_json(silent=True)
        allowed_types = {"refresh", "ph_measurement", "dough_temperature", "fridge_in", "fridge_out",
                         "target_temperature", "manual_note", "incident"}
        if not isinstance(payload, dict) or payload.get("event_type") not in allowed_types:
            abort(400, description="event_type no vàlid")
        fermentation_id = payload.get("fermentation_id") or active_fermentation_id()
        if fermentation_id is not None:
            try:
                fermentation_id = int(fermentation_id)
            except (TypeError, ValueError):
                abort(400)
            if not read_rows("SELECT id FROM fermentations WHERE id=?", (fermentation_id,)):
                abort(404, description="fermentació no trobada")
        fields = {
            "fermentation_id": fermentation_id,
            "event_type": payload["event_type"],
            "starter_mass_g": optional_number(payload, "starter_mass_g", 0, 100000),
            "flour_g": optional_number(payload, "flour_g", 0, 100000),
            "water_g": optional_number(payload, "water_g", 0, 100000),
            "flour_type": str(payload.get("flour_type", ""))[:120] or None,
            "hydration_pct": optional_number(payload, "hydration_pct", 0, 500),
            "ph": optional_number(payload, "ph", 0, 14),
            "dough_temp_c": optional_number(payload, "dough_temp_c", -20, 100),
            "target_temp_c": optional_number(payload, "target_temp_c", -20, 100),
            "details": str(payload.get("details", ""))[:2000] or None,
        }
        return jsonify(add_event(fields)), 201

    # Read-only, bearer-token API designed for a future MCP bridge. The token is
    # independent from browser login and can never authorize control operations.
    @app.get("/api/v1/status")
    @readonly_api_required
    def v1_status():
        db = sqlite3.connect(Path(settings.database_path).resolve().as_uri() + "?mode=ro", uri=True, timeout=15)
        try:
            session_id = active_fermentation_id(db)
            counts = {name: db.execute(f"SELECT count(*) FROM {name} WHERE fermentation_id=?", (session_id,)).fetchone()[0]
                      if session_id is not None else 0 for name in ("readings", "photos", "events")}
        finally:
            db.close()
        control = read_rows("SELECT active,changed_at FROM monitoring_control WHERE id=1", ())
        latest = {"reading": next(iter(read_rows("SELECT * FROM readings ORDER BY captured_at DESC,id DESC LIMIT 1", ())), None),
                  "photo": next(iter(read_rows("SELECT * FROM photos ORDER BY captured_at DESC,id DESC LIMIT 1", ())), None)}
        return jsonify({"application_version": APP_VERSION, "monitoring": {"active": bool(control[0]["active"]), "changed_at": control[0]["changed_at"]} if control else {"active": False, "changed_at": None},
                        "capture_intervals_seconds": {"readings": settings.sensor_interval_seconds,
                                                       "photos": settings.photo_interval_seconds},
                        "latest": latest, "active_fermentation_id": session_id,
                        "active_fermentation_counts": counts})

    @app.get("/api/v1/readings")
    @readonly_api_required
    def v1_readings():
        start, end = query_range(); limit, offset = page_params()
        clause, params = add_range_clauses("captured_at", start, end)
        fermentation_id = fermentation_filter()
        if fermentation_id is not None:
            clause += " AND" if clause else " WHERE"
            clause += " fermentation_id=?"; params.append(fermentation_id)
        rows = read_rows(f"SELECT * FROM readings{clause} ORDER BY captured_at,id LIMIT ? OFFSET ?", params + [limit + 1, offset])
        return jsonify(paginated(rows, limit, offset))

    @app.get("/api/v1/photos")
    @readonly_api_required
    def v1_photos():
        start, end = query_range(); limit, offset = page_params()
        clause, params = add_range_clauses("captured_at", start, end)
        fermentation_id = fermentation_filter()
        if fermentation_id is not None:
            clause += " AND" if clause else " WHERE"
            clause += " fermentation_id=?"; params.append(fermentation_id)
        rows = read_rows(f"SELECT id,captured_at,filename,camera_ok,error,growth_score,growth_detected,analysis_json,fermentation_id FROM photos{clause} ORDER BY captured_at,id LIMIT ? OFFSET ?", params + [limit + 1, offset])
        page = paginated(rows, limit, offset)
        rows = page["items"]
        for row in rows:
            row["image_url"] = f"/api/v1/photos/{row['id']}/image" if row["camera_ok"] and row["filename"] else None
        page["items"] = rows
        return jsonify(page)

    def photo_by_id(photo_id):
        rows = read_rows("SELECT * FROM photos WHERE id=?", (photo_id,))
        if not rows:
            abort(404)
        return rows[0]

    @app.get("/api/v1/photos/<int:photo_id>")
    @readonly_api_required
    def v1_photo(photo_id):
        row = photo_by_id(photo_id)
        row["image_url"] = f"/api/v1/photos/{photo_id}/image" if row["camera_ok"] and row["filename"] else None
        return jsonify(row)

    @app.get("/api/v1/photos/<int:photo_id>/image")
    @readonly_api_required
    def v1_photo_image(photo_id):
        row = photo_by_id(photo_id)
        filename = row.get("filename") or ""
        if not row.get("camera_ok") or not filename or filename != os.path.basename(filename) or ".." in filename:
            abort(404)
        path = os.path.join(settings.photo_dir, filename)
        if not os.path.isfile(path):
            abort(404)
        return send_file(path, mimetype="image/jpeg", conditional=True, max_age=0)

    @app.get("/api/v1/events")
    @readonly_api_required
    def v1_events():
        start, end = query_range(); limit, offset = page_params()
        clause, params = add_range_clauses("occurred_at", start, end)
        fermentation_id = fermentation_filter()
        if fermentation_id is not None:
            clause += " AND" if clause else " WHERE"
            clause += " fermentation_id=?"; params.append(fermentation_id)
        rows = read_rows(f"SELECT * FROM events{clause} ORDER BY occurred_at,id LIMIT ? OFFSET ?", params + [limit + 1, offset])
        return jsonify(paginated(rows, limit, offset))

    @app.get("/api/v1/fermentations")
    @readonly_api_required
    def v1_fermentations():
        start, end = query_range(); limit, offset = page_params()
        clauses, params = [], []
        if start:
            clauses.append("started_at >= ?"); params.append(start)
        if end:
            clauses.append("started_at < ?"); params.append(end)
        clause = " WHERE " + " AND ".join(clauses) if clauses else ""
        rows = read_rows(f"SELECT * FROM fermentations{clause} ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?", params + [limit + 1, offset])
        return jsonify(paginated(rows, limit, offset))

    @app.get("/api/v1/fermentations/<int:fermentation_id>")
    @readonly_api_required
    def v1_fermentation(fermentation_id):
        rows = read_rows("SELECT * FROM fermentations WHERE id=?", (fermentation_id,))
        if not rows:
            abort(404)
        result = rows[0]
        result["counts"] = {"readings": read_rows("SELECT count(*) AS n FROM readings WHERE fermentation_id=?", (fermentation_id,))[0]["n"],
                             "photos": read_rows("SELECT count(*) AS n FROM photos WHERE fermentation_id=?", (fermentation_id,))[0]["n"],
                             "events": read_rows("SELECT count(*) AS n FROM events WHERE fermentation_id=?", (fermentation_id,))[0]["n"]}
        result["events"] = read_rows("SELECT * FROM events WHERE fermentation_id=? ORDER BY occurred_at,id", (fermentation_id,))
        return jsonify(result)

    @app.get("/api/v1/export")
    @readonly_api_required
    def v1_export():
        start, end = query_range()
        if not start or not end:
            abort(400, description="start i end són obligatoris")
        archive, metadata = build_session_zip(
            settings.database_path, settings.photo_dir, start, end,
            app_version=APP_VERSION, timezone_name="Europe/Madrid",
            sensor_interval_seconds=settings.sensor_interval_seconds,
            photo_interval_seconds=settings.photo_interval_seconds,
            supplied_session_id=request.args.get("session_id"))
        response = send_file(archive, mimetype="application/zip", as_attachment=True,
                             download_name="panettone_export.zip", max_age=0)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Panettone-Readings"] = str(metadata["counts"]["reading_records"])
        response.headers["X-Panettone-Photos"] = str(metadata["counts"]["photo_files_exported"])
        return response

    @app.get("/api/v1/fermentations/<int:fermentation_id>/export")
    @readonly_api_required
    def v1_fermentation_export(fermentation_id):
        rows = read_rows("SELECT * FROM fermentations WHERE id=?", (fermentation_id,))
        if not rows:
            abort(404)
        item = rows[0]
        end = item["ended_at"] or datetime.now(timezone.utc).isoformat(timespec="seconds")
        archive, metadata = build_session_zip(
            settings.database_path, settings.photo_dir, item["started_at"], end,
            app_version=APP_VERSION, timezone_name="Europe/Madrid",
            sensor_interval_seconds=settings.sensor_interval_seconds,
            photo_interval_seconds=settings.photo_interval_seconds,
            supplied_session_id=str(fermentation_id))
        response = send_file(archive, mimetype="application/zip", as_attachment=True,
                             download_name=f"panettone_fermentacio_{fermentation_id}.zip", max_age=0)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Panettone-Readings"] = str(metadata["counts"]["reading_records"])
        response.headers["X-Panettone-Photos"] = str(metadata["counts"]["photo_files_exported"])
        return response

    @app.get("/api/growth")
    @login_required
    def growth():
        config = growth_config()
        photo = latest_analyzed_photo()
        measurement = None
        if photo:
            try:
                measurement = json.loads(photo["analysis_json"] or "{}")
            except (TypeError, ValueError):
                measurement = None
        baseline = config["baseline"]
        change_points = None
        direction = "pendent"
        if measurement and measurement.get("valid") and photo:
            direction = "sense_referencia"
            if baseline and isinstance(baseline.get("height_ratio"), (int, float)):
                change_points = round((photo["growth_score"] - baseline["height_ratio"]) * 100, 1)
                if change_points > 1.5:
                    direction = "pujant"
                elif change_points < -1.5:
                    direction = "baixant"
                else:
                    direction = "estable"
        return jsonify({"roi": config["roi"], "baseline": baseline, "photo": photo,
                        "measurement": measurement, "change_points": change_points,
                        "direction": direction})

    @app.post("/api/growth/preview")
    @login_required
    def growth_preview():
        # This one-off preview is intentionally not added to the photo history.
        payload = request.get_json(silent=True)
        roi = growth_config()["roi"]
        if payload is not None:
            if not isinstance(payload, dict):
                abort(400)
            supplied_roi = payload.get("roi")
            if supplied_roi is not None:
                if not isinstance(supplied_roi, dict):
                    abort(400)
                try:
                    roi = {key: round(float(supplied_roi[key]), 4)
                           for key in ("x0", "y0", "x1", "y1")}
                except (KeyError, TypeError, ValueError):
                    abort(400)
                if (any(not 0 <= value <= 1 for value in roi.values()) or
                        roi["x1"] - roi["x0"] < 0.06 or roi["y1"] - roi["y0"] < 0.12):
                    abort(400)
        try:
            with tempfile.TemporaryDirectory(prefix="panettone-preview-") as directory:
                path = os.path.join(directory, "preview.jpg")
                capture_photo(path)
                try:
                    analysis = analyze_image(path, roi)
                    measurement = json.loads(analysis["analysis_json"])
                except Exception:
                    # Keep calibration useful if an unusual frame cannot be analyzed.
                    measurement = {"valid": False, "reason": "preview_analysis_failed"}
                with open(path, "rb") as image_file:
                    image = BytesIO(image_file.read())
        except Exception:
            return jsonify({"error": "No s’ha pogut obtenir una captura actual. Comprova que la càmera estigui connectada."}), 503
        image.seek(0)
        response = send_file(image, mimetype="image/jpeg", download_name="growth-preview.jpg", max_age=0)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Growth-Valid"] = "true" if measurement.get("valid") else "false"
        if measurement.get("valid"):
            response.headers["X-Growth-Score"] = str(measurement.get("height_ratio", ""))
            response.headers["X-Growth-Confidence"] = str(measurement.get("confidence", ""))
        else:
            response.headers["X-Growth-Reason"] = str(measurement.get("reason", "unknown"))
        return response

    @app.get("/api/growth/history")
    @login_required
    def growth_readings():
        limit = request.args.get("limit", default=500, type=int)
        if limit is None:
            abort(400)
        return jsonify(growth_history(min(2000, max(1, limit))))

    @app.post("/api/growth/roi")
    @login_required
    def growth_roi():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            abort(400)
        roi = {}
        try:
            for key in ("x0", "y0", "x1", "y1"):
                value = float(payload[key])
                if not 0 <= value <= 1:
                    abort(400)
                roi[key] = round(value, 4)
        except (KeyError, TypeError, ValueError):
            abort(400)
        if roi["x1"] - roi["x0"] < 0.06 or roi["y1"] - roi["y0"] < 0.12:
            abort(400)
        save_growth_roi(roi)
        photo = latest_analyzed_photo()
        if photo and photo.get("filename"):
            path = os.path.join(settings.photo_dir, photo["filename"])
            if os.path.isfile(path):
                analysis = analyze_image(path, roi)
                update_photo_analysis(photo["id"], analysis)
        return growth()

    @app.post("/api/growth/calibrate")
    @login_required
    def growth_calibrate():
        photo = latest_analyzed_photo()
        if not photo:
            return jsonify({"error": "Encara no hi ha cap captura amb detecció fiable."}), 409
        try:
            measurement = json.loads(photo["analysis_json"] or "{}")
        except (TypeError, ValueError):
            measurement = {}
        if (not measurement.get("valid") or
                float(measurement.get("confidence", 0)) < 0.45):
            return jsonify({"error": "La darrera captura no és prou clara per fixar la referència."}), 409
        set_growth_baseline(photo["growth_score"], photo["captured_at"])
        return growth()

    @app.get("/photos/<path:filename>")
    @login_required
    def photo_file(filename):
        if filename in ("", ".") or "/" in filename or ".." in filename:
            abort(404)
        return send_from_directory(settings.photo_dir, filename, conditional=True)

    return app


app = create_app(start_background=False)

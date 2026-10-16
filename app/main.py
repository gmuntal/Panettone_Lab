import os
import json
import tempfile
import threading
from io import BytesIO
from functools import wraps

from flask import Flask, abort, jsonify, redirect, render_template, request, send_file, send_from_directory, session, url_for

from .config import settings, validate_settings
from .database import (growth_config, growth_history, init_db, latest_analyzed_photo,
                       monitoring_state, set_monitoring_active,
                       latest_state, recent_photos, recent_readings, save_growth_roi,
                       set_growth_baseline, update_photo_analysis)
from .devices import capture_photo
from .growth_detection import analyze_image
from .scheduler import start_workers


def create_app(start_background=False):
    validate_settings()
    init_db()
    app = Flask(__name__)
    app.secret_key = settings.app_secret_key
    app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                      SESSION_COOKIE_SECURE=settings.session_cookie_secure, MAX_CONTENT_LENGTH=1024 * 1024)
    app.extensions["workers_stop"] = start_workers() if start_background else threading.Event()

    def login_required(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            if not session.get("authenticated"):
                if request.path.startswith("/api/"):
                    return jsonify({"error": "cal iniciar sessió"}), 401
                return redirect(url_for("login", next=request.path))
            return fn(*args, **kwargs)
        return wrapped

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

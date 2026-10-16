import os
import threading
from functools import wraps

from flask import Flask, abort, jsonify, redirect, render_template, request, send_from_directory, session, url_for

from .config import settings, validate_settings
from .database import init_db, latest_state, recent_photos, recent_readings
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

    @app.get("/photos/<path:filename>")
    @login_required
    def photo_file(filename):
        if filename in ("", ".") or "/" in filename or ".." in filename:
            abort(404)
        return send_from_directory(settings.photo_dir, filename, conditional=True)

    return app


app = create_app(start_background=False)

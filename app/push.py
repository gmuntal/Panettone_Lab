"""Optional Web Push with opt-in subscriptions and a deduplicated SQLite outbox."""
import json
from urllib.parse import urlsplit

from .config import settings
from .database import connect, utc_now

CATEGORY_PREF = {"critical": "critical_enabled", "warning": "warning_enabled",
                 "fermentation": "fermentation_enabled", "storage": "storage_enabled"}


def configured():
    subject = settings.webpush_subject
    return bool(settings.webpush_vapid_public_key and settings.webpush_vapid_private_key
                and (subject.startswith("mailto:") or subject.startswith("https://")))


def state():
    with connect() as db:
        devices = [dict(row) for row in db.execute("SELECT created_at,last_sent_at,last_error FROM push_subscriptions ORDER BY created_at")]
        prefs = dict(db.execute("SELECT * FROM push_preferences WHERE id=1").fetchone())
        last = db.execute("SELECT sent_at,category FROM push_outbox WHERE sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1").fetchone()
    return {"configured": configured(), "subscription_count": len(devices), "devices": devices, "preferences": prefs,
            "last_notification": dict(last) if last else None}


def save_subscription(value):
    if not isinstance(value, dict) or not isinstance(value.get("endpoint"), str):
        raise ValueError("Subscripció invàlida")
    endpoint = value["endpoint"]
    keys = value.get("keys") if isinstance(value.get("keys"), dict) else {}
    p256dh, auth = keys.get("p256dh"), keys.get("auth")
    parsed = urlsplit(endpoint)
    if parsed.scheme != "https" or not parsed.netloc or len(endpoint) > 2048:
        raise ValueError("L’endpoint de notificació ha de ser HTTPS vàlid")
    if not isinstance(p256dh, str) or not isinstance(auth, str) or len(p256dh) > 256 or len(auth) > 256:
        raise ValueError("Claus de subscripció invàlides")
    with connect() as db:
        db.execute("""INSERT INTO push_subscriptions(endpoint,p256dh,auth,created_at)
                   VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET
                   p256dh=excluded.p256dh,auth=excluded.auth,last_error=NULL""",
                   (endpoint, p256dh, auth, utc_now()))
    return state()


def remove_subscription(endpoint):
    if not isinstance(endpoint, str) or len(endpoint) > 2048:
        raise ValueError("Subscripció invàlida")
    with connect() as db:
        db.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))
    return state()


def update_preferences(value):
    if not isinstance(value, dict) or set(value) - set(CATEGORY_PREF):
        raise ValueError("Preferències de notificació invàlides")
    with connect() as db:
        current = dict(db.execute("SELECT * FROM push_preferences WHERE id=1").fetchone())
        new = {column: current[column] for column in CATEGORY_PREF.values()}
        for category, enabled in value.items():
            if not isinstance(enabled, bool):
                raise ValueError("Cada preferència ha de ser booleana")
            new[CATEGORY_PREF[category]] = int(enabled)
        db.execute("""UPDATE push_preferences SET critical_enabled=?,warning_enabled=?,
                   fermentation_enabled=?,storage_enabled=?,updated_at=? WHERE id=1""",
                   tuple(new[col] for col in ("critical_enabled", "warning_enabled", "fermentation_enabled", "storage_enabled")) + (utc_now(),))
    return state()


def _send_one(subscription, title, body, category, tag=None):
    if not configured():
        raise RuntimeError("Cal configurar les claus VAPID a la Raspberry Pi")
    from pywebpush import WebPushException, webpush
    try:
        webpush({"endpoint": subscription["endpoint"],
                 "keys": {"p256dh": subscription["p256dh"], "auth": subscription["auth"]}},
                json.dumps({"title": title, "body": body, "category": category,
                            "tag": tag or category, "url": "/#fermenter"}),
                vapid_private_key=settings.webpush_vapid_private_key,
                vapid_claims={"sub": settings.webpush_subject}, timeout=8)
    except WebPushException as exc:
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None)
        if status in (404, 410):
            with connect() as db:
                db.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (subscription["endpoint"],))
        raise


def send_test(endpoint=None):
    if not configured():
        raise RuntimeError("Notificacions no configurades: calen claus VAPID al servidor")
    with connect() as db:
        if endpoint:
            rows = db.execute("SELECT * FROM push_subscriptions WHERE endpoint=?", (endpoint,)).fetchall()
        else:
            rows = db.execute("SELECT * FROM push_subscriptions ORDER BY created_at").fetchall()
    if not rows:
        raise ValueError("No hi ha cap dispositiu subscrit")
    success, errors = 0, []
    for row in rows:
        try:
            _send_one(dict(row), "Panettone Lab", "Notificació de prova rebuda correctament.", "test")
            success += 1
            with connect() as db:
                db.execute("UPDATE push_subscriptions SET last_sent_at=?,last_error=NULL WHERE endpoint=?", (utc_now(), row["endpoint"]))
        except Exception as exc:
            errors.append(type(exc).__name__)
            with connect() as db:
                db.execute("UPDATE push_subscriptions SET last_error=? WHERE endpoint=?", (type(exc).__name__, row["endpoint"]))
    if not success:
        raise RuntimeError("No s’ha pogut enviar la notificació de prova: " + ", ".join(errors))
    return {"sent": success, "errors": len(errors)}


def enqueue(category, title, body, dedupe_key):
    if category not in CATEGORY_PREF or not configured():
        return False
    with connect() as db:
        prefs = db.execute("SELECT * FROM push_preferences WHERE id=1").fetchone()
        if not prefs[CATEGORY_PREF[category]]:
            return False
        if not db.execute("SELECT 1 FROM push_subscriptions LIMIT 1").fetchone():
            return False
        db.execute("""INSERT OR IGNORE INTO push_outbox(dedupe_key,category,title,body,created_at)
                   VALUES(?,?,?,?,?)""", (dedupe_key[:180], category, title[:120], body[:500], utc_now()))
        return db.total_changes > 0


def deliver_pending_once():
    if not configured():
        return
    with connect() as db:
        row = db.execute("SELECT * FROM push_outbox WHERE sent_at IS NULL AND attempts<5 ORDER BY id LIMIT 1").fetchone()
        subscriptions = [dict(item) for item in db.execute("SELECT * FROM push_subscriptions ORDER BY created_at")]
    if not row or not subscriptions:
        return
    notification = dict(row)
    errors = []
    sent = 0
    for subscription in subscriptions:
        try:
            _send_one(subscription, notification["title"], notification["body"], notification["category"], notification["dedupe_key"])
            sent += 1
            with connect() as db:
                db.execute("UPDATE push_subscriptions SET last_sent_at=?,last_error=NULL WHERE endpoint=?", (utc_now(), subscription["endpoint"]))
        except Exception as exc:
            errors.append(type(exc).__name__)
            with connect() as db:
                db.execute("UPDATE push_subscriptions SET last_error=? WHERE endpoint=?", (type(exc).__name__, subscription["endpoint"]))
    with connect() as db:
        db.execute("UPDATE push_outbox SET attempts=attempts+1,sent_at=?,last_error=? WHERE id=?",
                   (utc_now() if sent else None, ",".join(errors)[:500] or None, notification["id"]))


def worker(stop):
    while not stop.is_set():
        try:
            deliver_pending_once()
        except Exception:
            pass
        stop.wait(5)

"""Optional, independent dough-temperature acquisition; never drives the heater."""
import ipaddress
import json
import logging
import math
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

import requests

from . import config, database

log = logging.getLogger(__name__)
DEVICE_ID = "panettone-probe-01"
SENSOR_ROM = "28:19:94:2E:10:00:00:54"
SOURCE_MAX_AGE_MS = 15000


class ProbeError(ValueError):
    pass


def get_config():
    with database.connect() as db:
        result = dict(db.execute("SELECT * FROM dough_probe_settings WHERE id=1").fetchone())
    result.pop("id")
    result["enabled"] = bool(result["enabled"])
    result["token_configured"] = bool(config.settings.dough_probe_token)
    result["interval_seconds"] = config.settings.dough_probe_interval_seconds
    return result


def validate_url(value):
    if not isinstance(value, str) or len(value) > 200:
        raise ValueError("Indica una URL local de la sonda")
    try:
        parts = urlsplit(value)
        address = ipaddress.IPv4Address(parts.hostname or "")
        valid = (parts.scheme == "http" and parts.port in (None, 80) and
                 parts.path == "/api/status" and not parts.query and not parts.fragment and
                 parts.username is None and parts.password is None and address.is_private and
                 not any((address.is_loopback, address.is_link_local, address.is_multicast,
                          address.is_unspecified, address.is_reserved)))
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("La URL ha de ser http://<IPv4 privada>/api/status, port 80")
    return f"http://{address}/api/status"


def update_config(payload):
    if not isinstance(payload, dict) or set(payload) - {"enabled", "url"}:
        raise ValueError("Configuració de sonda invàlida")
    if "enabled" in payload and type(payload["enabled"]) is not bool:
        raise ValueError("enabled ha de ser un booleà")
    url = validate_url(payload["url"]) if "url" in payload else None
    if payload.get("enabled") and not config.settings.dough_probe_token:
        raise ValueError("Configura DOUGH_PROBE_TOKEN al servidor abans d’activar la sonda")
    with database.connect() as db:
        current = dict(db.execute("SELECT * FROM dough_probe_settings WHERE id=1").fetchone())
        enabled = int(payload.get("enabled", bool(current["enabled"])))
        url = url or current["url"]
        if enabled != current["enabled"] or url != current["url"]:
            db.execute("UPDATE dough_probe_settings SET enabled=?,url=?,revision=revision+1 WHERE id=1",
                       (enabled, url))
    return status()


def number(payload, key, minimum, maximum, integer=False):
    value = payload.get(key)
    if (type(value) not in (int, float) or not math.isfinite(value) or
            not minimum <= value <= maximum or (integer and type(value) is not int)):
        raise ProbeError("invalid_payload")
    return value


def validate_sample(payload, elapsed_ms=0):
    if not isinstance(payload, dict) or type(payload.get("schema_version")) is not int or payload["schema_version"] != 1:
        raise ProbeError("unsupported_schema")
    if payload.get("device_id") != DEVICE_ID or payload.get("sensor_rom") != SENSOR_ROM:
        raise ProbeError("unexpected_sensor")
    if payload.get("valid") is not True or payload.get("error") is not None:
        raise ProbeError("invalid_sensor_reading")
    if payload.get("wifi_connected") is not True:
        raise ProbeError("invalid_payload")
    age = number(payload, "sample_age_ms", 0, 4294967295)
    good_age = number(payload, "last_good_age_ms", 0, 4294967295)
    if max(age, good_age) + elapsed_ms > SOURCE_MAX_AGE_MS:
        raise ProbeError("stale_sample")
    raw = number(payload, "raw_temperature_c", -55, 125)
    offset = number(payload, "offset_c", -1, 1)
    temperature = number(payload, "temperature_c", -56, 126)
    if raw == 85 or abs(temperature - (raw + offset)) > .021:
        raise ProbeError("invalid_temperature")
    sequence = number(payload, "sample_sequence", 1, 4294967295, integer=True)
    boot_id = payload.get("boot_id")
    if not isinstance(boot_id, str) or not re.fullmatch(r"[a-f0-9]{16}", boot_id):
        raise ProbeError("invalid_payload")
    rssi = number(payload, "rssi_dbm", -127, 0, integer=True)
    return {"temperature_c": temperature, "raw_temperature_c": raw, "offset_c": offset,
            "device_id": DEVICE_ID, "sensor_rom": SENSOR_ROM, "boot_id": boot_id,
            "sample_sequence": sequence, "sample_age_ms": age + elapsed_ms, "rssi_dbm": rssi}


def record_result(probe_config, sample=None, error=None):
    """Discard requests completed after a pause/config change; link in one transaction."""
    with database.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        current = db.execute("SELECT enabled,revision FROM dough_probe_settings WHERE id=1").fetchone()
        monitoring = db.execute("SELECT active FROM monitoring_control WHERE id=1").fetchone()
        if not current["enabled"] or current["revision"] != probe_config["revision"] or not monitoring["active"]:
            return False
        if sample is not None:
            previous = db.execute("""SELECT boot_id,sample_sequence FROM dough_probe_readings
                WHERE sensor_ok=1 AND config_revision=? ORDER BY id DESC LIMIT 1""",
                (current["revision"],)).fetchone()
            if previous and previous["boot_id"] == sample["boot_id"] and sample["sample_sequence"] <= previous["sample_sequence"]:
                error, sample = "repeated_or_regressed_sample", None
        sample = sample or {}
        db.execute("""INSERT INTO dough_probe_readings(captured_at,temperature_c,raw_temperature_c,
            offset_c,sensor_ok,error,device_id,sensor_rom,boot_id,sample_sequence,sample_age_ms,
            rssi_dbm,config_revision,fermentation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (database.utc_now(), sample.get("temperature_c"), sample.get("raw_temperature_c"),
             sample.get("offset_c"), int(error is None), error, sample.get("device_id", DEVICE_ID),
             sample.get("sensor_rom", SENSOR_ROM), sample.get("boot_id"), sample.get("sample_sequence"),
             sample.get("sample_age_ms"), sample.get("rssi_dbm"), current["revision"], database.active_fermentation_id(db)))
    return True


def poll_once(probe_config=None):
    probe_config = probe_config or get_config()
    if not probe_config["enabled"] or not database.monitoring_state()["active"]:
        return False
    sample, error = None, None
    try:
        if not config.settings.dough_probe_token:
            raise ProbeError("token_not_configured")
        url = validate_url(probe_config["url"])
        started = time.monotonic()
        with requests.get(url, headers={"Authorization": "Bearer " + config.settings.dough_probe_token},
                          timeout=(3, 5), allow_redirects=False, stream=True) as response:
            if response.status_code in (401, 403):
                raise ProbeError("authentication_failed")
            if response.status_code != 200:
                raise ProbeError("unexpected_http_status")
            # Read at most 16 KiB; neither credentials nor raw responses are logged.
            body = bytearray()
            for chunk in response.iter_content(chunk_size=4096):
                body.extend(chunk)
                if len(body) > 16384:
                    raise ProbeError("invalid_payload")
            payload = json.loads(body)
        sample = validate_sample(payload, (time.monotonic() - started) * 1000)
    except requests.Timeout:
        error = "timeout"
    except requests.RequestException:
        error = "connection_failed"
    except ProbeError as exc:
        error = str(exc)
    except (ValueError, TypeError, OverflowError):
        error = "invalid_payload"
    return record_result(probe_config, sample, error)


def status():
    probe_config = get_config()
    with database.connect() as db:
        row = db.execute("SELECT * FROM dough_probe_readings WHERE config_revision=? ORDER BY id DESC LIMIT 1",
                         (probe_config["revision"],)).fetchone()
    reading = dict(row) if row else None
    age = None
    if reading:
        age = max(0, (datetime.now(timezone.utc) - datetime.fromisoformat(reading["captured_at"])).total_seconds())
    if not probe_config["enabled"]:
        state = "disabled"
    elif not probe_config["token_configured"]:
        state = "token_not_configured"
    elif not database.monitoring_state()["active"]:
        state = "paused"
    elif reading is None:
        state = "waiting"
    elif age > max(70, config.settings.dough_probe_interval_seconds * 2 + 10):
        state = "stale"
    elif not reading["sensor_ok"]:
        state = reading["error"]
    else:
        state = "ok"
    return {"config": probe_config, "state": state, "valid": state == "ok",
            "temperature_c": reading["temperature_c"] if state == "ok" else None,
            "last_attempt_at": reading["captured_at"] if reading else None,
            "age_seconds": age}


def readings(hours=24, fermentation_id=None):
    # ISO8601 comparisons use the same UTC format, avoiding a date-only cutoff.
    from datetime import timedelta
    start = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds")
    clause, params = "captured_at >= ?", [start]
    if fermentation_id is not None:
        clause += " AND fermentation_id=?"
        params.append(fermentation_id)
    with database.connect() as db:
        return [dict(row) for row in db.execute(
            f"SELECT * FROM dough_probe_readings WHERE {clause} ORDER BY captured_at,id", params)]


def worker(stop):
    revision, due = None, 0
    while not stop.is_set():
        try:
            current = get_config()
            if not current["enabled"] or not database.monitoring_state()["active"]:
                due = 0
            else:
                if current["revision"] != revision:
                    revision, due = current["revision"], 0
                if time.monotonic() >= due:
                    poll_once(current)
                    due = time.monotonic() + config.settings.dough_probe_interval_seconds
        except Exception:
            # Exception messages from HTTP libraries may contain sensitive request data.
            log.warning("Error intern del lector de sonda de massa")
            due = time.monotonic() + config.settings.dough_probe_interval_seconds
        stop.wait(1)

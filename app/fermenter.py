"""Fermenter controller simulation. This module intentionally has no RPC write path."""
import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .database import active_fermentation_id, connect, utc_now

LOCAL_TZ = ZoneInfo("Europe/Madrid")
MAX_SENSOR_AGE_SECONDS = 75


def _parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _finite_number(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _switch_state(status, key):
    """Keep unknown/unreported physical output states distinct from OFF."""
    value = status.get(key, {}).get("output")
    return value if isinstance(value, bool) else None


def schedule_state(config, now=None):
    now = now or datetime.now(LOCAL_TZ)
    if config["continuous"] or not config["schedule_enabled"]:
        return {"allowed": True, "next_change": None, "label": "Continu"}
    start_h, start_m = (int(part) for part in config["schedule_start"].split(":"))
    end_h, end_m = (int(part) for part in config["schedule_end"].split(":"))
    start = now.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
    end = now.replace(hour=end_h, minute=end_m, second=0, microsecond=0)
    if start == end:
        return {"allowed": False, "next_change": None, "label": "Horari buit"}
    if end < start:
        if now >= start:
            allowed, next_change = True, end + timedelta(days=1)
        elif now < end:
            allowed, next_change = True, end
        else:
            allowed, next_change = False, start
    else:
        if start <= now < end:
            allowed, next_change = True, end
        elif now < start:
            allowed, next_change = False, start
        else:
            allowed, next_change = False, start + timedelta(days=1)
    return {"allowed": allowed, "next_change": next_change.isoformat(),
            "label": "Actiu" if allowed else "Fora d’horari"}


def decide_simulated_output(config, runtime, temperature, sensor_valid, now=None):
    """Return (output, reason, lockout); safety OFF bypasses minimum switching time."""
    now = now or datetime.now(timezone.utc)
    current = bool(runtime.get("simulated_heater_on"))
    target = float(config["target_c"])
    schedule = schedule_state(config, now.astimezone(LOCAL_TZ))
    lockout = runtime.get("lockout_reason")
    if config["mode"] == "stopped":
        return False, "Aturat", None
    if lockout:
        return False, f"Bloqueig: {lockout}", lockout
    if not sensor_valid or temperature is None:
        return False, "Sensor invàlid o sense comunicació", None
    if temperature >= config["overtemp_c"]:
        return False, "Alarma de sobretemperatura", "overtemperature"
    if not schedule["allowed"]:
        return False, "Fora de l’horari programat", None
    on_since = runtime.get("heater_on_since")
    if current and on_since:
        try:
            if (now - _parse_time(on_since)).total_seconds() >= config["max_on_seconds"]:
                return False, "Temps màxim d’activació assolit", "max_on_time"
        except ValueError:
            return False, "Temporitzador invàlid; sortida segura", "timer_invalid"
    if config["mode"] == "manual":
        wanted = bool(config["manual_on"])
    elif config["mode"] == "automatic":
        if current:
            wanted = temperature < target + config["hysteresis_c"]
        else:
            wanted = temperature <= target - config["hysteresis_c"]
    else:
        return False, "Mode desconegut; sortida segura", "invalid_mode"
    last_change = runtime.get("last_switch_at")
    if wanted != current and last_change:
        try:
            elapsed = (now - _parse_time(last_change)).total_seconds()
            if elapsed < config["min_switch_seconds"]:
                return current, "Espera del temps mínim entre commutacions", None
        except ValueError:
            return False, "Temporitzador invàlid; sortida segura", "timer_invalid"
    return wanted, "Demanda simulada" if wanted else "Consigna assolida", None


def get_state(history_limit=120):
    with connect() as db:
        config = dict(db.execute("SELECT * FROM fermenter_settings WHERE id=1").fetchone())
        runtime = dict(db.execute("SELECT * FROM fermenter_runtime WHERE id=1").fetchone())
        actions = [dict(row) for row in db.execute(
            "SELECT * FROM fermenter_actions ORDER BY occurred_at DESC,id DESC LIMIT ?", (history_limit,))]
    scheduled = schedule_state(config)
    age = None
    if runtime.get("observed_at"):
        try:
            age = max(0, int((datetime.now(timezone.utc) - _parse_time(runtime["observed_at"])).total_seconds()))
        except ValueError:
            pass
    runtime["sensor_age_seconds"] = age
    runtime["sensor_fresh"] = bool(runtime.get("sensor_ok") and age is not None and age <= MAX_SENSOR_AGE_SECONDS)
    return {"config": config, "runtime": runtime, "schedule": scheduled,
            "simulation_only": True, "real_output_control_enabled": False,
            "actions": actions}


def _write_action(db, event_type, config, runtime, details):
    db.execute("""INSERT INTO fermenter_actions(occurred_at,fermentation_id,event_type,mode,
               temperature_c,target_c,simulated_heater_on,details) VALUES(?,?,?,?,?,?,?,?)""",
               (utc_now(), active_fermentation_id(db), event_type, config["mode"],
                runtime.get("temperature_c"), config["target_c"],
                int(bool(runtime.get("simulated_heater_on"))), details))


def safe_start():
    """Persistently put the simulator in STOPPED after every application restart."""
    with connect() as db:
        config = dict(db.execute("SELECT * FROM fermenter_settings WHERE id=1").fetchone())
        runtime = dict(db.execute("SELECT * FROM fermenter_runtime WHERE id=1").fetchone())
        changed = config["mode"] != "stopped" or bool(runtime["simulated_heater_on"])
        db.execute("UPDATE fermenter_settings SET mode='stopped',manual_on=0,updated_at=? WHERE id=1", (utc_now(),))
        db.execute("UPDATE fermenter_runtime SET simulated_heater_on=0,heater_on_since=NULL,reason='Restart segur: simulació aturada' WHERE id=1")
        config["mode"] = "stopped"
        runtime["simulated_heater_on"] = 0
        if changed:
            _write_action(db, "safe_restart", config, runtime,
                          "Reinici de l’aplicació: només simulació; cap ordre al Shelly")


def update_settings(payload):
    allowed = {"mode", "target_c", "hysteresis_c", "min_switch_seconds", "max_on_seconds",
               "overtemp_c", "schedule_enabled", "continuous", "schedule_start", "schedule_end",
               "manual_on", "acknowledge_alarm"}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValueError("Configuració no vàlida")
    with connect() as db:
        config = dict(db.execute("SELECT * FROM fermenter_settings WHERE id=1").fetchone())
        runtime = dict(db.execute("SELECT * FROM fermenter_runtime WHERE id=1").fetchone())
        new = dict(config)
        if "mode" in payload:
            if payload["mode"] not in ("automatic", "manual", "stopped"):
                raise ValueError("Mode no vàlid")
            new["mode"] = payload["mode"]
        limits = {"target_c": (15.0, 30.0), "hysteresis_c": (0.1, 2.0),
                  "overtemp_c": (30.0, 40.0), "min_switch_seconds": (0, 900),
                  "max_on_seconds": (60, 7200)}
        for key, (low, high) in limits.items():
            if key in payload:
                try:
                    value = float(payload[key])
                except (TypeError, ValueError):
                    raise ValueError(f"{key} no és numèric")
                if not math.isfinite(value) or value < low or value > high:
                    raise ValueError(f"{key} fora del rang {low}–{high}")
                new[key] = int(value) if key.endswith("seconds") else value
        if new["overtemp_c"] <= new["target_c"] + new["hysteresis_c"]:
            raise ValueError("La protecció de sobretemperatura ha d’estar per damunt de la consigna")
        for key in ("schedule_enabled", "continuous", "manual_on"):
            if key in payload:
                if not isinstance(payload[key], bool):
                    raise ValueError(f"{key} ha de ser booleà")
                new[key] = int(payload[key])
        for key in ("schedule_start", "schedule_end"):
            if key in payload:
                value = payload[key]
                try:
                    datetime.strptime(value, "%H:%M")
                except (TypeError, ValueError):
                    raise ValueError(f"{key} ha de tenir format HH:MM")
                new[key] = value
        if payload.get("acknowledge_alarm"):
            if runtime.get("temperature_c") is not None and runtime["temperature_c"] >= new["overtemp_c"] - 2:
                raise ValueError("No es pot confirmar l’alarma mentre la temperatura continua alta")
            db.execute("UPDATE fermenter_runtime SET lockout_reason=NULL WHERE id=1")
            runtime["lockout_reason"] = None
        changed_keys = [key for key in new if key in allowed and new[key] != config[key]]
        db.execute("""UPDATE fermenter_settings SET mode=?,target_c=?,hysteresis_c=?,min_switch_seconds=?,
                   max_on_seconds=?,overtemp_c=?,schedule_enabled=?,continuous=?,schedule_start=?,schedule_end=?,
                   manual_on=?,updated_at=? WHERE id=1""", tuple(new[key] for key in (
                       "mode", "target_c", "hysteresis_c", "min_switch_seconds", "max_on_seconds",
                       "overtemp_c", "schedule_enabled", "continuous", "schedule_start", "schedule_end",
                       "manual_on")) + (utc_now(),))
        if changed_keys or payload.get("acknowledge_alarm"):
            _write_action(db, "configuration", new, runtime,
                          "Canvi: " + ", ".join(changed_keys or ["confirmació d’alarma"]))
    return get_state()


def poll_once(now=None):
    """Read live sensor/output status, then evaluate only the virtual actuator."""
    from .devices import read_shelly_components
    now = now or datetime.now(timezone.utc)
    timestamp = now.isoformat(timespec="seconds")
    try:
        status = read_shelly_components()
        temperature = _finite_number(status.get("temperature:100", {}).get("tC"))
        humidity = _finite_number(status.get("humidity:100", {}).get("rh"))
        sensor_valid = temperature is not None and humidity is not None and -20 <= temperature <= 80 and 0 <= humidity <= 100
        error = None if sensor_valid else "Lectura ambiental invàlida"
        switches = (_switch_state(status, "switch:0"), _switch_state(status, "switch:1"))
    except Exception as exc:
        temperature = humidity = None
        sensor_valid = False
        error = type(exc).__name__
        switches = (None, None)
    with connect() as db:
        config = dict(db.execute("SELECT * FROM fermenter_settings WHERE id=1").fetchone())
        runtime = dict(db.execute("SELECT * FROM fermenter_runtime WHERE id=1").fetchone())
        old_error = runtime.get("error")
        if sensor_valid:
            runtime.update(temperature_c=temperature, humidity_rh=humidity, sensor_ok=1,
                           error=None, observed_at=timestamp)
        else:
            runtime.update(sensor_ok=0, error=error)
        runtime.update(switch0_on=switches[0], switch1_on=switches[1])
        age_ok = False
        if runtime.get("observed_at"):
            try:
                age_ok = (now - _parse_time(runtime["observed_at"])).total_seconds() <= MAX_SENSOR_AGE_SECONDS
            except ValueError:
                pass
        output, reason, lockout = decide_simulated_output(
            config, runtime, runtime.get("temperature_c"), sensor_valid and age_ok, now)
        if lockout and runtime.get("lockout_reason") != lockout:
            runtime["lockout_reason"] = lockout
            _write_action(db, "alarm", config, runtime, reason)
        elif not sensor_valid and old_error != error:
            _write_action(db, "alarm", config, runtime, reason)
        previous_output = bool(runtime.get("simulated_heater_on"))
        previous_reason = runtime.get("reason")
        if output != previous_output:
            runtime["last_switch_at"] = timestamp
            runtime["heater_on_since"] = timestamp if output else None
            runtime["simulated_heater_on"] = int(output)
            _write_action(db, "simulated_output_on" if output else "simulated_output_off", config, runtime, reason)
        runtime["reason"] = reason
        db.execute("""UPDATE fermenter_runtime SET observed_at=?,temperature_c=?,humidity_rh=?,sensor_ok=?,error=?,
                   switch0_on=?,switch1_on=?,simulated_heater_on=?,reason=?,heater_on_since=?,last_switch_at=?,
                   lockout_reason=? WHERE id=1""", (
                       runtime.get("observed_at"), runtime.get("temperature_c"), runtime.get("humidity_rh"),
                       int(bool(runtime.get("sensor_ok"))), runtime.get("error"), switches[0], switches[1],
                       int(bool(runtime.get("simulated_heater_on"))), reason, runtime.get("heater_on_since"),
                       runtime.get("last_switch_at"), runtime.get("lockout_reason")))
        if previous_reason != reason and reason.startswith(("Alarma", "Fora d’horari", "Sensor", "Bloqueig")):
            _write_action(db, "alarm" if reason.startswith(("Alarma", "Sensor", "Bloqueig")) else "schedule", config, runtime, reason)
    return get_state(history_limit=10)


def start_worker(stop, interval_seconds=5):
    safe_start()
    while not stop.is_set():
        try:
            poll_once()
        except Exception:
            # A controller crash must never escalate into a real actuator command.
            pass
        stop.wait(interval_seconds)


def history(hours=24):
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds")
    with connect() as db:
        readings = [dict(r) for r in db.execute(
            "SELECT captured_at,temperature_c,humidity_rh,sensor_ok FROM readings WHERE captured_at>=? ORDER BY captured_at,id",
            (cutoff,))]
        actions = [dict(r) for r in db.execute(
            "SELECT occurred_at,event_type,mode,temperature_c,target_c,simulated_heater_on,details FROM fermenter_actions WHERE occurred_at>=? ORDER BY occurred_at,id",
            (cutoff,))]
    return {"readings": readings, "actions": actions}

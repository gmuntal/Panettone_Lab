"""Fail-closed fermenter controller with an optionally armed Shelly output."""
import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .database import active_fermentation_id, connect, utc_now
from .config import settings, shelly_real_control_ready

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
            "simulation_only": not shelly_real_control_ready(),
            "real_output_control_enabled": shelly_real_control_ready(),
            "physical_control_block_reason": None if shelly_real_control_ready() else
              "Control real desarmat: cal habilitar-lo i verificar cablejat, tall tèrmic, estat segur al reinici i watchdog local del Shelly",
            "actions": actions}


def start_timed_test(duration_seconds):
    """Start an explicitly requested, bounded physical test; never used by startup."""
    if duration_seconds not in (10, 30, 60):
        raise ValueError("La prova només pot durar 10, 30 o 60 segons")
    if not shelly_real_control_ready():
        raise ValueError("Prova física bloquejada: les proteccions del Shelly encara no estan verificades i habilitades")
    now = datetime.now(timezone.utc)
    started = now.isoformat(timespec="seconds")
    until = (now + timedelta(seconds=duration_seconds)).isoformat(timespec="seconds")
    # Reserve in the database before touching the device: concurrent browsers
    # cannot start a second test or switch to automatic control in the gap.
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        config = dict(db.execute("SELECT * FROM fermenter_settings WHERE id=1").fetchone())
        runtime = dict(db.execute("SELECT * FROM fermenter_runtime WHERE id=1").fetchone())
        if config["mode"] != "stopped":
            raise ValueError("Atura primer el control automàtic o manual")
        if runtime.get("test_status") in ("starting", "running"):
            raise ValueError("Ja hi ha una prova de manta en curs")
        try:
            fresh_sensor = bool(runtime.get("observed_at") and
                                (now - _parse_time(runtime["observed_at"])).total_seconds() <= MAX_SENSOR_AGE_SECONDS)
        except (ValueError, TypeError):
            fresh_sensor = False
        if not runtime.get("sensor_ok") or not fresh_sensor or runtime.get("temperature_c") is None:
            raise ValueError("No es pot iniciar: falta una lectura ambiental vàlida")
        if float(runtime["temperature_c"]) >= float(config["overtemp_c"]):
            raise ValueError("No es pot iniciar: la temperatura ja supera el límit d’alarma")
        if runtime.get("switch0_on") is not False:
            raise ValueError("No es pot iniciar: l’estat de switch:0 no confirma que la manta estigui apagada")
        db.execute("UPDATE fermenter_runtime SET test_started_at=?,test_until=?,test_duration_seconds=?,test_status='starting',reason='Prova temporitzada en preparació' WHERE id=1",
                   (started, until, duration_seconds))
        _write_action(db, "blanket_test_starting", config, runtime, f"Reserva de prova física de {duration_seconds} s")
    try:
        from .devices import set_shelly_heater_output, read_shelly_heater_output
        set_shelly_heater_output(True, duration_seconds)
        observed = read_shelly_heater_output()
        if observed is not True:
            raise RuntimeError("El Shelly no confirma la sortida encesa")
        with connect() as db:
            config = dict(db.execute("SELECT * FROM fermenter_settings WHERE id=1").fetchone())
            runtime = dict(db.execute("SELECT * FROM fermenter_runtime WHERE id=1").fetchone())
            db.execute("UPDATE fermenter_runtime SET test_status='running',switch0_on=1,reason='Prova temporitzada de manta en curs',last_switch_at=?,heater_on_since=? WHERE id=1", (started, started))
            _write_action(db, "blanket_test_started", config, runtime, f"Shelly switch:0 confirmat ON; autoapagada local en {duration_seconds} s")
    except Exception as exc:
        try:
            from .devices import set_shelly_heater_output, read_shelly_heater_output
            set_shelly_heater_output(False, duration_seconds)
            off_confirmed = read_shelly_heater_output() is False
        except Exception:
            off_confirmed = False
        with connect() as db:
            config = dict(db.execute("SELECT * FROM fermenter_settings WHERE id=1").fetchone())
            runtime = dict(db.execute("SELECT * FROM fermenter_runtime WHERE id=1").fetchone())
            db.execute("UPDATE fermenter_runtime SET test_status='failed',test_until=NULL,switch0_on=?,error=?,reason='Prova fallida; s’ha demanat OFF' WHERE id=1",
                       (0 if off_confirmed else None, type(exc).__name__))
            _write_action(db, "blanket_test_failed", config, runtime,
                          f"{type(exc).__name__}; OFF confirmat={off_confirmed}")
        raise ValueError(f"Prova fallida ({type(exc).__name__}); s’ha demanat apagar la manta") from exc
    return get_state()


def stop_timed_test(reason="Prova aturada manualment"):
    if not shelly_real_control_ready():
        raise ValueError("No es pot enviar una ordre física: control Shelly bloquejat per seguretat")
    from .devices import set_shelly_heater_output, read_shelly_heater_output
    set_shelly_heater_output(False, settings.shelly_watchdog_seconds)
    off = read_shelly_heater_output() is False
    with connect() as db:
        config = dict(db.execute("SELECT * FROM fermenter_settings WHERE id=1").fetchone())
        runtime = dict(db.execute("SELECT * FROM fermenter_runtime WHERE id=1").fetchone())
        status = "stopped" if off else "failed"
        db.execute("UPDATE fermenter_runtime SET test_status=?,test_until=NULL,switch0_on=?,heater_on_since=NULL,reason=? WHERE id=1",
                   (status, 0 if off else None, reason if off else "OFF no confirmat"))
        _write_action(db, "blanket_test_stopped" if off else "blanket_test_failed", config, runtime,
                      reason if off else "El Shelly no confirma OFF")
    if not off:
        raise ValueError("El Shelly no confirma OFF. Comprova el dispositiu immediatament.")
    return get_state()


def _write_action(db, event_type, config, runtime, details):
    db.execute("""INSERT INTO fermenter_actions(occurred_at,fermentation_id,event_type,mode,
               temperature_c,target_c,simulated_heater_on,details) VALUES(?,?,?,?,?,?,?,?)""",
               (utc_now(), active_fermentation_id(db), event_type, config["mode"],
                runtime.get("temperature_c"), config["target_c"],
                int(bool(runtime.get("simulated_heater_on"))), details))


def safe_start():
    """Persistently stop the controller on restart; request physical OFF if armed."""
    with connect() as db:
        config = dict(db.execute("SELECT * FROM fermenter_settings WHERE id=1").fetchone())
        runtime = dict(db.execute("SELECT * FROM fermenter_runtime WHERE id=1").fetchone())
        changed = config["mode"] != "stopped" or bool(runtime["simulated_heater_on"]) or runtime.get("test_status") in ("starting", "running")
        db.execute("UPDATE fermenter_settings SET mode='stopped',manual_on=0,updated_at=? WHERE id=1", (utc_now(),))
        db.execute("UPDATE fermenter_runtime SET simulated_heater_on=0,heater_on_since=NULL,test_status=CASE WHEN test_status IN ('starting','running') THEN 'interrupted' ELSE test_status END,test_until=NULL,reason='Reinici segur: controlador aturat' WHERE id=1")
        config["mode"] = "stopped"
        runtime["simulated_heater_on"] = 0
        if changed:
            _write_action(db, "safe_restart", config, runtime,
                          "Reinici: demanda local aturada")
    if shelly_real_control_ready():
        try:
            from .devices import set_shelly_heater_output
            set_shelly_heater_output(False, settings.shelly_watchdog_seconds)
        except Exception:
            # Startup remains stopped; the next worker cycle retries OFF.
            pass


def update_settings(payload):
    allowed = {"mode", "target_c", "hysteresis_c", "min_switch_seconds", "max_on_seconds",
               "overtemp_c", "schedule_enabled", "continuous", "schedule_start", "schedule_end",
               "manual_on", "acknowledge_alarm"}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValueError("Configuració no vàlida")
    with connect() as db:
        config = dict(db.execute("SELECT * FROM fermenter_settings WHERE id=1").fetchone())
        runtime = dict(db.execute("SELECT * FROM fermenter_runtime WHERE id=1").fetchone())
        if runtime.get("test_status") in ("starting", "running") and payload.get("mode", "stopped") != "stopped":
            raise ValueError("La prova temporitzada té el control exclusiu de la manta")
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
    """Read sensor/output status, calculate demand and optionally drive gated output."""
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
    push_alerts = []
    with connect() as db:
        config = dict(db.execute("SELECT * FROM fermenter_settings WHERE id=1").fetchone())
        runtime = dict(db.execute("SELECT * FROM fermenter_runtime WHERE id=1").fetchone())
        old_error = runtime.get("error")
        previous_observed_switch = runtime.get("switch0_on")
        switch0_at_poll = switches[0]
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
        real_control = shelly_real_control_ready()
        test_status = runtime.get("test_status")
        test_until = runtime.get("test_until")
        test_active = test_status in ("starting", "running") and test_until
        if test_active:
            try:
                expired = now >= _parse_time(test_until)
            except ValueError:
                expired = True
            if expired:
                try:
                    from .devices import set_shelly_heater_output, read_shelly_heater_output
                    set_shelly_heater_output(False, settings.shelly_watchdog_seconds)
                    off_confirmed = read_shelly_heater_output() is False
                except Exception:
                    off_confirmed = False
                output, reason, lockout = False, "Prova acabada · OFF confirmat" if off_confirmed else "Error: OFF de prova no confirmat", None
                runtime["test_status"] = "completed" if off_confirmed else "failed"
                runtime["test_until"] = None
                switches = (False if off_confirmed else None, switches[1])
                _write_action(db, "blanket_test_completed" if off_confirmed else "blanket_test_failed",
                              config, runtime, reason)
            else:
                output, reason, lockout = bool(switches[0]), "Prova temporitzada en curs", None
                if switches[0] is not True:
                    runtime["test_status"] = "failed"
                    runtime["test_until"] = None
                    output, reason, lockout = False, "La manta s’ha apagat abans d’acabar la prova", None
                    _write_action(db, "blanket_test_failed", config, runtime, reason)
        else:
            output, reason, lockout = decide_simulated_output(
                config, runtime, runtime.get("temperature_c"), sensor_valid and age_ok, now)
        if real_control:
            try:
                from .devices import set_shelly_heater_output
                if test_active:
                    pass  # The device-side toggle_after owns the test timeout.
                elif output or switches[0] is not False:
                    set_shelly_heater_output(output, settings.shelly_watchdog_seconds)
                from .devices import read_shelly_heater_output
                switches = (read_shelly_heater_output(), switches[1])
                if switches[0] is not output:
                    raise RuntimeError("L’estat llegit no coincideix amb l’ordre enviada")
            except Exception as exc:
                output = False
                reason = f"Shelly no confirma l’ordre; sortida segura demanada: {type(exc).__name__}"
                runtime["error"] = type(exc).__name__
                # A write may have reached the Shelly even if read-back failed;
                # always send OFF and report the physical state as unknown.
                switches = (None, switches[1])
                try:
                    from .devices import set_shelly_heater_output
                    set_shelly_heater_output(False, settings.shelly_watchdog_seconds)
                except Exception:
                    pass
        if lockout and runtime.get("lockout_reason") != lockout:
            runtime["lockout_reason"] = lockout
            _write_action(db, "alarm", config, runtime, reason)
            push_alerts.append(("critical", "Protecció de la fermentadora", reason,
                                f"fermenter-lockout:{lockout}"))
        elif not sensor_valid and old_error != error:
            _write_action(db, "alarm", config, runtime, reason)
            push_alerts.append(("critical", "Lectura del Shelly invàlida", reason,
                                f"fermenter-sensor:{error}:{timestamp[:13]}"))
        if switch0_at_poll is True and not output and not bool(runtime.get("simulated_heater_on")):
            details = "switch:0 era encesa sense demanda prèvia del controlador; s’ha revisat l’estat."
            if previous_observed_switch is not True:
                _write_action(db, "alarm", config, runtime, details)
                push_alerts.append(("critical", "Manta activada inesperadament", details,
                                    f"fermenter-unexpected-on:{timestamp[:13]}"))

        # Trend warnings use only actual historical samples. If monitoring was
        # paused or the series lacks coverage, no guess is produced.
        if sensor_valid and runtime.get("observed_at"):
            for minutes, kind in ((10, "off_rising"), (15, "on_no_rise")):
                if kind == "off_rising" and (switch0_at_poll is not False or output):
                    continue
                if kind == "on_no_rise" and (switch0_at_poll is not True or not runtime.get("heater_on_since")):
                    continue
                if kind == "on_no_rise":
                    try:
                        if (now - _parse_time(runtime["heater_on_since"])).total_seconds() < minutes * 60:
                            continue
                    except ValueError:
                        continue
                cutoff = (now - timedelta(minutes=minutes)).isoformat(timespec="seconds")
                old_sample = db.execute("SELECT temperature_c FROM readings WHERE sensor_ok=1 AND temperature_c IS NOT NULL AND captured_at<=? ORDER BY captured_at DESC,id DESC LIMIT 1", (cutoff,)).fetchone()
                if not old_sample:
                    continue
                delta = temperature - float(old_sample[0])
                anomalous = (delta >= 1.0) if kind == "off_rising" else (delta < 0.2)
                if not anomalous:
                    continue
                cooldown_key = f"temperature-{kind}"
                recent = db.execute("SELECT 1 FROM fermenter_actions WHERE event_type=? AND occurred_at>=? LIMIT 1",
                    (cooldown_key, (now - timedelta(minutes=30)).isoformat(timespec="seconds"))).fetchone()
                if recent:
                    continue
                details = (f"Temperatura ambiental ha pujat {delta:.1f} °C en {minutes} min amb switch:0 apagat."
                           if kind == "off_rising" else f"La temperatura ambiental gairebé no ha pujat ({delta:.1f} °C en {minutes} min) amb switch:0 encès; possible incidència, no és un diagnòstic.")
                _write_action(db, cooldown_key, config, runtime, details)
                push_alerts.append(("warning", "Tendència de temperatura inusual", details,
                                    f"fermenter-{kind}:{timestamp[:13]}"))
        if real_control and runtime.get("error") and runtime.get("error") != old_error and sensor_valid:
            push_alerts.append(("critical", "Error del control tèrmic", runtime["error"],
                                f"fermenter-control:{runtime['error']}:{timestamp[:13]}"))
        previous_output = bool(runtime.get("simulated_heater_on"))
        previous_reason = runtime.get("reason")
        if output != previous_output:
            runtime["last_switch_at"] = timestamp
            runtime["heater_on_since"] = timestamp if output else None
            runtime["simulated_heater_on"] = int(output)
            if not real_control:
                _write_action(db, f"simulated_output_{'on' if output else 'off'}", config, runtime, reason)
        if (real_control and switches[0] is not None and
                switches[0] != previous_observed_switch):
            _write_action(db, f"physical_output_{'on' if switches[0] else 'off'}", config,
                          runtime, "Canvi físic llegit de Shelly switch:0")
        runtime["reason"] = reason
        db.execute("""UPDATE fermenter_runtime SET observed_at=?,temperature_c=?,humidity_rh=?,sensor_ok=?,error=?,
                   switch0_on=?,switch1_on=?,simulated_heater_on=?,reason=?,heater_on_since=?,last_switch_at=?,
                   lockout_reason=?,test_started_at=?,test_until=?,test_duration_seconds=?,test_status=? WHERE id=1""", (
                       runtime.get("observed_at"), runtime.get("temperature_c"), runtime.get("humidity_rh"),
                       int(bool(runtime.get("sensor_ok"))), runtime.get("error"), switches[0], switches[1],
                       int(bool(runtime.get("simulated_heater_on"))), reason, runtime.get("heater_on_since"),
                       runtime.get("last_switch_at"), runtime.get("lockout_reason"),runtime.get("test_started_at"),
                       runtime.get("test_until"),runtime.get("test_duration_seconds"),runtime.get("test_status")))
        if previous_reason != reason and reason.startswith(("Alarma", "Fora d’horari", "Sensor", "Bloqueig")):
            _write_action(db, "alarm" if reason.startswith(("Alarma", "Sensor", "Bloqueig")) else "schedule", config, runtime, reason)
    for category, title, body, dedupe_key in push_alerts:
        try:
            from .push import enqueue
            enqueue(category, title, body, dedupe_key)
        except Exception:
            log.exception("No s’ha pogut posar una alerta a la cua")
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

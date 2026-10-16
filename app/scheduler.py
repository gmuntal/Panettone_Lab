import logging
import os
import threading
import time
from datetime import datetime

from .config import settings
from .database import add_photo, add_reading, growth_config, monitoring_state
from .devices import capture_photo, read_shelly
from .growth_detection import analyze_image

log = logging.getLogger(__name__)


def wait_for_next_cycle(stop, seconds):
    for _ in range(seconds):
        if stop.wait(1) or not monitoring_state()["active"]:
            return False
    return True


def sensor_loop(stop):
    while not stop.is_set():
        if not monitoring_state()["active"]:
            stop.wait(1)
            continue
        try:
            temperature, humidity = read_shelly()
            if monitoring_state()["active"]:
                add_reading(temperature, humidity)
        except Exception as exc:
            log.warning("Lectura Shelly fallida: %s", exc)
            if monitoring_state()["active"]:
                add_reading(None, None, type(exc).__name__)
        wait_for_next_cycle(stop, settings.sensor_interval_seconds)


def photo_loop(stop):
    while not stop.is_set():
        if not monitoring_state()["active"]:
            stop.wait(1)
            continue
        filename = datetime.now().strftime("%Y%m%d-%H%M%S.jpg")
        destination = os.path.join(settings.photo_dir, filename)
        try:
            capture_photo(destination)
            if not monitoring_state()["active"]:
                os.remove(destination)
                continue
            try:
                analysis = analyze_image(destination, growth_config()["roi"])
            except Exception:
                log.exception("Anàlisi visual de creixement fallida")
                analysis = None
            if monitoring_state()["active"]:
                add_photo(filename, analysis=analysis)
            else:
                os.remove(destination)
        except Exception as exc:
            log.warning("Captura de càmera fallida: %s", exc)
            if monitoring_state()["active"]:
                add_photo("", type(exc).__name__)
        wait_for_next_cycle(stop, settings.photo_interval_seconds)


def start_workers():
    stop = threading.Event()
    for target, name in ((sensor_loop, "shelly-poller"), (photo_loop, "camera-capture")):
        threading.Thread(target=target, args=(stop,), name=name, daemon=True).start()
    return stop

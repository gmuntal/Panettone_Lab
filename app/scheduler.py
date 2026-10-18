import logging
import json
import os
import threading
import time
from datetime import datetime

from .config import settings
from .database import add_photo, add_reading, growth_config, latest_analyzed_photo, monitoring_state
from .devices import capture_photo, read_shelly
from .growth_detection import DETECTOR_VERSION, analyze_image, reproject_surface_ratio

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
                previous_ratio = None
                roi = growth_config()["roi"]
                previous_photo = latest_analyzed_photo()
                if previous_photo and previous_photo.get("growth_score") is not None:
                    try:
                        previous_analysis = json.loads(previous_photo.get("analysis_json") or "{}")
                        if previous_analysis.get("detector_version") == DETECTOR_VERSION:
                            if previous_analysis.get("roi") == roi:
                                previous_ratio = float(previous_photo["growth_score"])
                            else:
                                previous_ratio = reproject_surface_ratio(
                                    previous_analysis.get("surface_y_ratio"), roi)
                    except (TypeError, ValueError):
                        pass
                analysis = analyze_image(destination, roi, previous_ratio)
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
    from .fermenter import start_worker as fermenter_worker
    threading.Thread(target=fermenter_worker, args=(stop,), name="fermenter-simulation", daemon=True).start()
    return stop

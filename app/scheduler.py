import logging
import os
import threading
import time
from datetime import datetime

from .config import settings
from .database import add_photo, add_reading
from .devices import capture_photo, read_shelly

log = logging.getLogger(__name__)


def sensor_loop(stop):
    while not stop.is_set():
        try:
            temperature, humidity = read_shelly()
            add_reading(temperature, humidity)
        except Exception as exc:
            log.warning("Lectura Shelly fallida: %s", exc)
            add_reading(None, None, type(exc).__name__)
        stop.wait(settings.sensor_interval_seconds)


def photo_loop(stop):
    while not stop.is_set():
        filename = datetime.now().strftime("%Y%m%d-%H%M%S.jpg")
        destination = os.path.join(settings.photo_dir, filename)
        try:
            capture_photo(destination)
            add_photo(filename)
        except Exception as exc:
            log.warning("Captura de càmera fallida: %s", exc)
            add_photo("", type(exc).__name__)
        stop.wait(settings.photo_interval_seconds)


def start_workers():
    stop = threading.Event()
    for target, name in ((sensor_loop, "shelly-poller"), (photo_loop, "camera-capture")):
        threading.Thread(target=target, args=(stop,), name=name, daemon=True).start()
    return stop

import os
import subprocess
import tempfile
from urllib.parse import quote, urlsplit, urlunsplit

import requests
from requests.auth import HTTPDigestAuth

from .config import settings


def read_shelly_components():
    auth = None
    if settings.shelly_username:
        auth = HTTPDigestAuth(settings.shelly_username, settings.shelly_password)
    response = requests.get(settings.shelly_url, auth=auth, timeout=8)
    response.raise_for_status()
    return response.json()


def set_shelly_heater_output(on, watchdog_seconds=15):
    """Set the confirmed heater output; ON calls carry a Shelly-side lease."""
    from .config import shelly_real_control_ready
    if not shelly_real_control_ready():
        raise RuntimeError("Control real Shelly bloquejat per configuració de seguretat")
    url = settings.shelly_url.rsplit("/rpc/", 1)[0] + "/rpc/Switch.Set"
    auth = HTTPDigestAuth(settings.shelly_username, settings.shelly_password) if settings.shelly_username else None
    params = {"id": 0, "on": bool(on), "tag": "PanettoneLab"}
    if on:
        params["toggle_after"] = int(watchdog_seconds)
    response = requests.post(url, json=params, auth=auth, timeout=4)
    response.raise_for_status()
    result = response.json()
    if not isinstance(result, dict) or not isinstance(result.get("was_on"), bool):
        raise RuntimeError("El Shelly no ha confirmat Switch.Set")
    return result


def read_shelly_heater_output():
    """Read back switch:0 so the UI never treats a requested state as observed."""
    url = settings.shelly_url.rsplit("/rpc/", 1)[0] + "/rpc/Switch.GetStatus"
    auth = HTTPDigestAuth(settings.shelly_username, settings.shelly_password) if settings.shelly_username else None
    response = requests.get(url, params={"id": 0}, auth=auth, timeout=4)
    response.raise_for_status()
    output = response.json().get("output")
    if not isinstance(output, bool):
        raise RuntimeError("No s’ha pogut llegir l’estat real de switch:0")
    return output


def read_shelly():
    payload = read_shelly_components()
    temperature = payload
    humidity = payload
    for part in settings.temperature_key.split("."):
        temperature = temperature[part]
    for part in settings.humidity_key.split("."):
        humidity = humidity[part]
    return float(temperature), float(humidity)


def camera_url():
    url = settings.camera_rtsp_url
    if settings.camera_username:
        parts = urlsplit(url)
        host = parts.hostname or ""
        if parts.port:
            host += f":{parts.port}"
        credentials = f"{quote(settings.camera_username)}:{quote(settings.camera_password)}@"
        url = urlunsplit((parts.scheme, credentials + host, parts.path, parts.query, parts.fragment))
    return url


def capture_photo(destination):
    # FFmpeg is used as a subprocess so RTSP access stays out of the web request path.
    subprocess.run([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp",
        "-i", camera_url(), "-frames:v", "1", "-q:v", "3", "-y", destination,
    ], check=True, timeout=25, capture_output=True)
    if not os.path.exists(destination) or os.path.getsize(destination) < 1000:
        raise RuntimeError("La càmera no ha retornat una imatge vàlida")

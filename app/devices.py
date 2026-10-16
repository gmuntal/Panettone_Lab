import os
import subprocess
import tempfile
from urllib.parse import quote, urlsplit, urlunsplit

import requests
from requests.auth import HTTPDigestAuth

from .config import settings


def read_shelly():
    auth = None
    if settings.shelly_username:
        auth = HTTPDigestAuth(settings.shelly_username, settings.shelly_password)
    response = requests.get(settings.shelly_url, auth=auth, timeout=8)
    response.raise_for_status()
    payload = response.json()
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

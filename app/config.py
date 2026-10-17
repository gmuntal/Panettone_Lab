import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    data_dir: str = os.getenv("DATA_DIR", "/data")
    database_path: str = os.getenv("DATABASE_PATH", "/data/panettone.db")
    photo_dir: str = os.getenv("PHOTO_DIR", "/data/photos")
    app_secret_key: str = os.getenv("APP_SECRET_KEY", "")
    auth_username: str = os.getenv("AUTH_USERNAME", "")
    auth_password: str = os.getenv("AUTH_PASSWORD", "")
    readonly_api_token: str = os.getenv("READONLY_API_TOKEN", "")
    session_cookie_secure: bool = os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true"
    shelly_url: str = os.getenv("SHELLY_URL", "http://10.85.3.202/rpc/Shelly.GetStatus")
    shelly_username: str = os.getenv("SHELLY_USERNAME", "")
    shelly_password: str = os.getenv("SHELLY_PASSWORD", "")
    temperature_key: str = os.getenv("TEMPERATURE_KEY", "temperature:100.tC")
    humidity_key: str = os.getenv("HUMIDITY_KEY", "humidity:100.rh")
    camera_rtsp_url: str = os.getenv("CAMERA_RTSP_URL", "rtsp://10.85.3.237:554/stream1")
    camera_username: str = os.getenv("CAMERA_USERNAME", "")
    camera_password: str = os.getenv("CAMERA_PASSWORD", "")
    sensor_interval_seconds: int = int(os.getenv("SENSOR_INTERVAL_SECONDS", "30"))
    photo_interval_seconds: int = int(os.getenv("PHOTO_INTERVAL_SECONDS", "120"))


settings = Settings()


def validate_settings() -> None:
    if not settings.app_secret_key or len(settings.app_secret_key) < 32:
        raise RuntimeError("APP_SECRET_KEY must be configured with at least 32 characters")
    if not settings.auth_username or not settings.auth_password:
        raise RuntimeError("AUTH_USERNAME and AUTH_PASSWORD must be configured")
    if settings.readonly_api_token and len(settings.readonly_api_token) < 32:
        raise RuntimeError("READONLY_API_TOKEN must have at least 32 characters when configured")
    if settings.sensor_interval_seconds < 5 or settings.photo_interval_seconds < 30:
        raise RuntimeError("Polling intervals are too short")

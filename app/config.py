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
    shelly_output_id: int = int(os.getenv("SHELLY_HEATER_OUTPUT_ID", "0"))
    shelly_real_control_enabled: bool = os.getenv("SHELLY_REAL_CONTROL_ENABLED", "false").lower() == "true"
    shelly_wiring_verified: bool = os.getenv("SHELLY_HEATER_WIRING_VERIFIED", "false").lower() == "true"
    shelly_cutoff_verified: bool = os.getenv("SHELLY_THERMAL_CUTOFF_VERIFIED", "false").lower() == "true"
    shelly_restart_off_verified: bool = os.getenv("SHELLY_RESTART_OFF_VERIFIED", "false").lower() == "true"
    shelly_watchdog_verified: bool = os.getenv("SHELLY_WATCHDOG_VERIFIED", "false").lower() == "true"
    shelly_watchdog_seconds: int = int(os.getenv("SHELLY_OUTPUT_WATCHDOG_SECONDS", "15"))
    temperature_key: str = os.getenv("TEMPERATURE_KEY", "temperature:100.tC")
    humidity_key: str = os.getenv("HUMIDITY_KEY", "humidity:100.rh")
    camera_rtsp_url: str = os.getenv("CAMERA_RTSP_URL", "rtsp://10.85.3.237:554/stream1")
    camera_username: str = os.getenv("CAMERA_USERNAME", "")
    camera_password: str = os.getenv("CAMERA_PASSWORD", "")
    sensor_interval_seconds: int = int(os.getenv("SENSOR_INTERVAL_SECONDS", "30"))
    photo_interval_seconds: int = int(os.getenv("PHOTO_INTERVAL_SECONDS", "120"))
    webpush_vapid_public_key: str = os.getenv("WEBPUSH_VAPID_PUBLIC_KEY", "")
    webpush_vapid_private_key: str = os.getenv("WEBPUSH_VAPID_PRIVATE_KEY", "")
    webpush_subject: str = os.getenv("WEBPUSH_SUBJECT", "")


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
    if settings.shelly_output_id != 0:
        raise RuntimeError("Only the user-confirmed Shelly output 0 is supported for the heater")
    if settings.shelly_watchdog_seconds < 10 or settings.shelly_watchdog_seconds > 60:
        raise RuntimeError("SHELLY_OUTPUT_WATCHDOG_SECONDS must be 10–60 seconds")
    if bool(settings.webpush_vapid_public_key) != bool(settings.webpush_vapid_private_key):
        raise RuntimeError("WEBPUSH_VAPID_PUBLIC_KEY i WEBPUSH_VAPID_PRIVATE_KEY s’han de configurar plegades")
    if settings.webpush_vapid_public_key and not settings.webpush_subject.startswith(("mailto:", "https://")):
        raise RuntimeError("WEBPUSH_SUBJECT ha de ser un correu de contacte mailto: o una URL HTTPS")


def shelly_real_control_ready() -> bool:
    return (settings.shelly_real_control_enabled and settings.shelly_wiring_verified
            and settings.shelly_cutoff_verified and settings.shelly_restart_off_verified
            and settings.shelly_watchdog_verified
            and settings.shelly_output_id == 0)

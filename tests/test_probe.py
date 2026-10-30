import copy
import csv
import io
import json
import os
import tempfile
import unittest
import zipfile
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import requests

from app import config, database, probe


def payload():
    # Actual schema returned by the verified ESP32, without any credentials.
    return {"schema_version": 1, "device_id": "panettone-probe-01",
            "sensor_rom": "28:19:94:2E:10:00:00:54", "boot_id": "45fbc6b63478240d",
            "valid": True, "temperature_c": 21.44, "raw_temperature_c": 21.44,
            "offset_c": 0.0, "error": None, "sample_sequence": 21,
            "sample_age_ms": 523, "last_good_age_ms": 523,
            "wifi_connected": True, "rssi_dbm": -62}


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_config, self.old_database = config.settings, database.settings
        config.settings = config.Settings(
            data_dir=self.temp.name, database_path=os.path.join(self.temp.name, "probe.db"),
            photo_dir=os.path.join(self.temp.name, "photos"), app_secret_key="s" * 32,
            auth_username="tester", auth_password="test-password",
            readonly_api_token="read-only-test-token-that-is-long-enough",
            dough_probe_token="private-probe-test-token")
        database.settings = config.settings
        from app import main
        self.main, self.old_main = main, main.settings
        main.settings = config.settings
        self.app = main.create_app(start_background=False)
        self.client = self.app.test_client()

    def tearDown(self):
        self.main.settings = self.old_main
        config.settings, database.settings = self.old_config, self.old_database
        self.temp.cleanup()

    def enable(self):
        database.set_monitoring_active(True)
        probe.update_config({"enabled": True})
        return probe.get_config()

    def response(self, data=None, status=200):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status_code = status
        response.iter_content.return_value = iter([json.dumps(data or payload()).encode()])
        return response

    def login(self):
        self.client.post("/login", data={"username": "tester", "password": "test-password"})

    def test_optional_probe_does_not_touch_environmental_history(self):
        database.add_reading(26.0, 60.0)
        with patch("app.probe.requests.get") as get:
            self.assertFalse(probe.poll_once())
        get.assert_not_called()
        self.assertEqual(probe.status()["state"], "disabled")
        database.init_db()  # migration is idempotent
        self.assertEqual(len(database.recent_readings()), 1)
        self.assertEqual(probe.readings(), [])

    def test_poll_records_corrected_value_once_and_links_session(self):
        session = database.start_fermentation({})
        self.enable()
        data = payload(); data.update(offset_c=.25, temperature_c=21.69)
        with patch("app.probe.requests.get", return_value=self.response(data)) as get:
            self.assertTrue(probe.poll_once())
        self.assertFalse(get.call_args.kwargs["allow_redirects"])
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer private-probe-test-token")
        row = probe.readings()[0]
        self.assertEqual(row["temperature_c"], 21.69)
        self.assertEqual(row["raw_temperature_c"], 21.44)
        self.assertEqual(row["fermentation_id"], session["id"])
        self.assertTrue(probe.status()["valid"])
        self.assertEqual(database.recent_readings(), [])

    def test_sensor_disconnect_timeout_auth_failure_and_recovery(self):
        self.enable()
        with patch("app.probe.requests.get", return_value=self.response()):
            probe.poll_once()
        with patch("app.probe.requests.get", side_effect=requests.Timeout()):
            probe.poll_once()
        self.assertEqual(probe.status()["state"], "timeout")
        self.assertIsNone(probe.status()["temperature_c"])
        bad = payload(); bad.update(valid=False, temperature_c=None, error="sensor_read_failed")
        with patch("app.probe.requests.get", return_value=self.response(bad)):
            probe.poll_once()
        self.assertEqual(probe.status()["state"], "invalid_sensor_reading")
        with patch("app.probe.requests.get", return_value=self.response(status=401)):
            probe.poll_once()
        self.assertEqual(probe.status()["state"], "authentication_failed")
        good = payload(); good["sample_sequence"] += 1
        with patch("app.probe.requests.get", return_value=self.response(good)):
            probe.poll_once()
        self.assertTrue(probe.status()["valid"])
        self.assertIsNone(probe.readings()[1]["temperature_c"])

    def test_rejects_stale_frozen_wrong_sensor_and_invalid_numbers(self):
        cases = [{"sample_age_ms": 15001}, {"last_good_age_ms": 15001},
                 {"valid": "true"}, {"temperature_c": float("nan")},
                 {"raw_temperature_c": 85, "temperature_c": 85},
                 {"offset_c": 0.5}, {"sample_sequence": True},
                 {"sensor_rom": "28:00:00:00:00:00:00:00"},
                 {"device_id": "another-device"}, {"schema_version": True}]
        for changes in cases:
            with self.subTest(changes=changes):
                data = payload(); data.update(changes)
                with self.assertRaises(probe.ProbeError):
                    probe.validate_sample(data)
        with self.assertRaises(probe.ProbeError):
            probe.validate_sample(payload(), elapsed_ms=15000)
        cfg = self.enable()
        sample = probe.validate_sample(payload())
        probe.record_result(cfg, sample)
        probe.record_result(cfg, sample)
        self.assertEqual(probe.status()["state"], "repeated_or_regressed_sample")
        restarted = dict(sample, boot_id="0123456789abcdef", sample_sequence=1)
        probe.record_result(cfg, restarted)
        self.assertTrue(probe.status()["valid"])

    def test_config_change_and_pause_discard_in_flight_results(self):
        old = self.enable()
        probe.update_config({"url": "http://10.85.3.104/api/status"})
        self.assertFalse(probe.record_result(old, probe.validate_sample(payload())))
        current = probe.get_config()
        database.set_monitoring_active(False)
        self.assertFalse(probe.record_result(current, probe.validate_sample(payload())))
        self.assertEqual(probe.readings(), [])
        self.assertEqual(probe.status()["state"], "paused")

    def test_old_success_is_not_live_and_configuration_persists(self):
        cfg = self.enable()
        probe.record_result(cfg, probe.validate_sample(payload()))
        old = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(timespec="seconds")
        with database.connect() as db:
            db.execute("UPDATE dough_probe_readings SET captured_at=?", (old,))
        self.assertEqual(probe.status()["state"], "stale")
        self.assertIsNone(probe.status()["temperature_c"])
        database.init_db()
        self.assertTrue(probe.get_config()["enabled"])

    def test_oversized_body_and_redirect_do_not_become_readings(self):
        self.enable()
        response = self.response(); response.iter_content.return_value = iter([b"x" * 16385])
        with patch("app.probe.requests.get", return_value=response):
            probe.poll_once()
        self.assertEqual(probe.status()["state"], "invalid_payload")
        with patch("app.probe.requests.get", return_value=self.response(status=302)):
            probe.poll_once()
        self.assertEqual(probe.status()["state"], "unexpected_http_status")

    def test_authenticated_configuration_never_returns_token(self):
        self.assertEqual(self.client.get("/api/probe").status_code, 401)
        self.assertEqual(self.client.post("/api/probe", json={"enabled": True}).status_code, 401)
        self.assertEqual(self.client.get("/api/probe/readings").status_code, 401)
        self.login()
        response = self.client.post("/api/probe", json={"enabled": True})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["config"]["token_configured"])
        self.assertNotIn(config.settings.dough_probe_token, response.get_data(as_text=True))
        for body in ({"enabled": "false"}, {"token": "bad"}, {"url": "http://8.8.8.8/api/status"},
                     {"url": "http://127.0.0.1/api/status"}, {"url": "http://10.85.3.103/other"}):
            self.assertEqual(self.client.post("/api/probe", json=body).status_code, 400)
        before = copy.deepcopy(probe.get_config())
        config.settings = replace(config.settings, dough_probe_token="")
        self.assertEqual(self.client.post("/api/probe", json={"enabled": True}).status_code, 400)
        self.assertEqual(probe.get_config()["revision"], before["revision"])

    def test_read_api_filters_and_export_keeps_both_sensor_sources(self):
        first = database.start_fermentation({})
        cfg = self.enable()
        database.add_reading(26.0, 60.0)
        probe.record_result(cfg, probe.validate_sample(payload()))
        database.end_fermentation(first["id"])
        second = database.start_fermentation({})
        data = payload(); data["sample_sequence"] += 1
        probe.record_result(cfg, probe.validate_sample(data))
        self.login()
        rows = self.client.get(f"/api/probe/readings?fermentation_id={first['id']}").json
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["fermentation_id"], first["id"])
        headers = {"Authorization": "Bearer " + config.settings.readonly_api_token}
        response = self.client.get(f"/api/v1/probe/readings?fermentation_id={second['id']}", headers=headers)
        self.assertEqual(len(response.json["items"]), 1)
        self.assertEqual(self.client.post("/api/probe", headers=headers, json={"enabled": False}).status_code, 200)
        # A bearer token alone cannot write: remove the browser session first.
        self.client.post("/logout")
        self.assertEqual(self.client.post("/api/probe", headers=headers, json={"enabled": True}).status_code, 401)
        from app.exporting import build_session_zip
        start = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        end = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        archive, metadata = build_session_zip(config.settings.database_path, config.settings.photo_dir, start, end)
        with zipfile.ZipFile(archive) as zipped:
            ambient = list(csv.DictReader(io.StringIO(zipped.read("readings.csv").decode())))
            dough = list(csv.DictReader(io.StringIO(zipped.read("dough_temperature.csv").decode())))
        archive.close()
        self.assertEqual(len(ambient), 1)
        self.assertEqual(len(dough), 2)
        self.assertEqual(metadata["counts"]["dough_probe_records"], 2)


if __name__ == "__main__":
    unittest.main()

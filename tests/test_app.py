import os
import tempfile
import unittest
from unittest.mock import patch


class AppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.environ["APP_SECRET_KEY"] = "test-secret-key-with-at-least-32-characters"
        os.environ["AUTH_USERNAME"] = "tester"
        os.environ["AUTH_PASSWORD"] = "correct-horse-battery-staple"
        os.environ["DATA_DIR"] = self.temp.name
        os.environ["DATABASE_PATH"] = os.path.join(self.temp.name, "test.db")
        os.environ["PHOTO_DIR"] = os.path.join(self.temp.name, "photos")
        from app.config import Settings
        from app import config, database
        config.settings = Settings()
        database.settings = config.settings
        from app.main import create_app
        self.app = create_app(start_background=False)
        self.client = self.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def test_dashboard_and_api_require_login(self):
        self.assertEqual(self.client.get("/").status_code, 302)
        self.assertEqual(self.client.get("/api/state").status_code, 401)

    def test_login_opens_dashboard_and_api(self):
        response = self.client.post("/login", data={"username": "tester", "password": "correct-horse-battery-staple"})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/api/state").json, {"photo": None, "reading": None})

    def test_pwa_resources_are_available(self):
        manifest = self.client.get("/manifest.webmanifest")
        service_worker = self.client.get("/service-worker.js")
        self.assertEqual(manifest.status_code, 200)
        self.assertEqual(service_worker.status_code, 200)
        manifest.close()
        service_worker.close()
        self.assertEqual(self.client.get("/healthz").json, {"status": "ok"})

    def test_bad_login_is_rejected(self):
        response = self.client.post("/login", data={"username": "tester", "password": "wrong"})
        self.assertEqual(response.status_code, 401)

    def test_growth_configuration_requires_login_and_can_be_calibrated(self):
        self.assertEqual(self.client.get("/api/growth").status_code, 401)
        self.assertEqual(self.client.post("/api/growth/preview").status_code, 401)
        self.client.post("/login", data={"username": "tester", "password": "correct-horse-battery-staple"})

        initial = self.client.get("/api/growth")
        self.assertEqual(initial.status_code, 200)
        self.assertEqual(initial.json["direction"], "pendent")
        self.assertIsNone(initial.json["baseline"])

        def fake_capture(destination):
            with open(destination, "wb") as image_file:
                image_file.write(b"jpeg-preview" + b"x" * 1024)

        with patch("app.main.capture_photo", side_effect=fake_capture):
            preview = self.client.post("/api/growth/preview")
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.mimetype, "image/jpeg")
        self.assertEqual(preview.headers["Cache-Control"], "no-store")
        self.assertTrue(preview.data.startswith(b"jpeg-preview"))
        self.assertFalse(os.path.exists(os.path.join(self.temp.name, "photos")))

        response = self.client.post("/api/growth/roi", json={"x0": 0.3, "y0": 0.2, "x1": 0.7, "y1": 0.9})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["roi"], {"x0": 0.3, "y0": 0.2, "x1": 0.7, "y1": 0.9})

        invalid = self.client.post("/api/growth/roi", json={"x0": 0.7, "y0": 0.2, "x1": 0.3, "y1": 0.9})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(self.client.post("/api/growth/calibrate", json={}).status_code, 409)


class DeviceTests(unittest.TestCase):
    def test_read_shelly_rpc_paths(self):
        from app.devices import read_shelly

        class Response:
            def raise_for_status(self):
                pass
            def json(self):
                return {"temperature:100": {"tC": 24.5}, "humidity:100": {"rh": 62.0}}

        with patch("app.devices.requests.get", return_value=Response()) as get:
            self.assertEqual(read_shelly(), (24.5, 62.0))
            get.assert_called_once()


if __name__ == "__main__":
    unittest.main()

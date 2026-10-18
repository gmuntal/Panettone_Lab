import os
import json
import struct
import tempfile
import unittest
from unittest.mock import patch


class AppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.environ["APP_SECRET_KEY"] = "test-secret-key-with-at-least-32-characters"
        os.environ["AUTH_USERNAME"] = "tester"
        os.environ["AUTH_PASSWORD"] = "correct-horse-battery-staple"
        os.environ["READONLY_API_TOKEN"] = "read-only-token-with-enough-entropy-for-tests"
        os.environ["DATA_DIR"] = self.temp.name
        os.environ["DATABASE_PATH"] = os.path.join(self.temp.name, "test.db")
        os.environ["PHOTO_DIR"] = os.path.join(self.temp.name, "photos")
        from app.config import Settings
        from app import config, database
        config.settings = Settings(data_dir=self.temp.name,
                                   database_path=os.path.join(self.temp.name, "test.db"),
                                   photo_dir=os.path.join(self.temp.name, "photos"),
                                   app_secret_key=os.environ["APP_SECRET_KEY"],
                                   auth_username=os.environ["AUTH_USERNAME"],
                                   auth_password=os.environ["AUTH_PASSWORD"],
                                   readonly_api_token=os.environ["READONLY_API_TOKEN"])
        database.settings = config.settings
        from app import main
        main.settings = config.settings
        from app.main import create_app
        self.app = create_app(start_background=False)
        self.client = self.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def test_growth_sequence_is_private_validated_and_never_cached(self):
        self.assertEqual(self.client.get('/api/growth/sequence?fermentation_id=1').status_code,401)
        self.client.post('/login',data={'username':'tester','password':'correct-horse-battery-staple'})
        self.app.config['VISUAL_ANALYSIS_BACKGROUND']=False
        for query in ['', '?fermentation_id=no', '?fermentation_id=1&reference_id=bad']:
            response=self.client.get('/api/growth/sequence'+query)
            self.assertEqual(response.status_code,400);self.assertIsInstance(response.json['error'],str)
        response=self.client.get('/api/growth/sequence?fermentation_id=999')
        self.assertEqual(response.status_code,404);self.assertEqual(response.headers['Cache-Control'],'no-store')

    def test_dashboard_and_api_require_login(self):
        self.assertEqual(self.client.get("/").status_code, 302)
        self.assertEqual(self.client.get("/api/state").status_code, 401)

    def test_login_opens_dashboard_and_api(self):
        response = self.client.post("/login", data={"username": "tester", "password": "correct-horse-battery-staple"})
        self.assertEqual(response.status_code, 302)
        dashboard = self.client.get("/")
        self.assertEqual(dashboard.status_code, 200)
        for section in (b'data-page="home"', b'data-page="fermenter"',
                        b'data-page="fermentations"', b'data-page="camera"',
                        b'data-page="settings"'):
            self.assertIn(section, dashboard.data)
        self.assertIn(b'Panettone Lab,', dashboard.data)
        self.assertIn(b'by gmuntal', dashboard.data)
        self.assertIn(b'v0.10.0', dashboard.data)
        self.assertEqual(self.client.get("/api/state").json, {"photo": None, "reading": None})

    def test_fermenter_api_is_authenticated_and_explicitly_simulated(self):
        self.assertEqual(self.client.get("/api/fermenter").status_code, 401)
        self.client.post("/login", data={"username": "tester", "password": "correct-horse-battery-staple"})
        state = self.client.get("/api/fermenter")
        self.assertEqual(state.status_code, 200)
        self.assertTrue(state.json["simulation_only"])
        self.assertFalse(state.json["real_output_control_enabled"])
        updated = self.client.post("/api/fermenter", json={"mode": "automatic", "target_c": 27.5})
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json["config"]["mode"], "automatic")
        self.assertFalse(updated.json["real_output_control_enabled"])

    def test_pwa_resources_are_available(self):
        manifest = self.client.get("/manifest.webmanifest")
        service_worker = self.client.get("/service-worker.js")
        self.assertEqual(manifest.status_code, 200)
        self.assertEqual(service_worker.status_code, 200)
        manifest.close()
        service_worker.close()
        self.assertEqual(self.client.get("/healthz").json, {"status": "ok"})

    def test_brand_assets_are_public_versioned_and_match_manifest(self):
        manifest_response = self.client.get("/manifest.webmanifest?v=0.10.0")
        self.assertEqual(manifest_response.status_code, 200)
        self.assertIn("no-store", manifest_response.headers["Cache-Control"])
        manifest = json.loads(manifest_response.data)
        self.assertEqual(manifest["name"], "Panettone Lab")
        self.assertEqual(manifest["start_url"], "/")
        self.assertEqual(manifest["scope"], "/")
        self.assertEqual({icon["sizes"] for icon in manifest["icons"]}, {"192x192", "512x512"})
        self.assertEqual(next(icon for icon in manifest["icons"] if icon["purpose"] == "maskable")["src"],
                         "/static/icons/icon-maskable-512.png?v=0.10.0")

        expected = {
            "/static/icons/apple-touch-icon.png?v=0.10.0": (180, 180),
            "/static/icons/favicon-32.png?v=0.10.0": (32, 32),
            "/static/icons/icon-192.png?v=0.10.0": (192, 192),
            "/static/icons/icon-512.png?v=0.10.0": (512, 512),
            "/static/icons/icon-maskable-512.png?v=0.10.0": (512, 512),
        }
        for url, dimensions in expected.items():
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.mimetype, "image/png")
                self.assertEqual(struct.unpack(">II", response.data[16:24]), dimensions)
        ico = self.client.get("/static/icons/favicon.ico?v=0.10.0")
        self.assertEqual(ico.status_code, 200)
        self.assertEqual(ico.data[:4], b"\x00\x00\x01\x00")
        self.assertEqual(struct.unpack("<H", ico.data[4:6])[0], 3)
        self.assertEqual([ico.data[i] for i in (6, 22, 38)], [16, 32, 48])

        sw = self.client.get("/service-worker.js")
        self.assertIn("no-store", sw.headers["Cache-Control"])
        self.assertIn(b"panettone-lab-v0.10.0", sw.data)
        login = self.client.get("/login")
        self.assertIn(b"v0.10.0", login.data)
        self.client.post("/login", data={"username": "tester", "password": "correct-horse-battery-staple"})
        dashboard = self.client.get("/")
        self.assertIn(b"/static/icons/icon-192.png?v=0.10.0", dashboard.data)
        self.assertIn(b"apple-touch-icon.png?v=0.10.0", dashboard.data)

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

        analysis = {"growth_score": 0.31, "analysis_json": '{"valid":true,"height_ratio":0.31,"confidence":0.82}'}
        with patch("app.main.capture_photo", side_effect=fake_capture), \
             patch("app.main.analyze_image", return_value=analysis) as analyze:
            preview = self.client.post("/api/growth/preview", json={"roi": {"x0": 0.3, "y0": 0.2, "x1": 0.7, "y1": 0.9}})
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.mimetype, "image/jpeg")
        self.assertEqual(preview.headers["Cache-Control"], "no-store")
        self.assertEqual(preview.headers["X-Growth-Valid"], "true")
        self.assertEqual(preview.headers["X-Growth-Score"], "0.31")
        self.assertEqual(preview.headers["X-Growth-Confidence"], "0.82")
        analyze.assert_called_once_with(analyze.call_args.args[0], {"x0": 0.3, "y0": 0.2, "x1": 0.7, "y1": 0.9})
        self.assertTrue(preview.data.startswith(b"jpeg-preview"))
        self.assertEqual(os.listdir(os.path.join(self.temp.name, "photos")), [])

        response = self.client.post("/api/growth/roi", json={"x0": 0.3, "y0": 0.2, "x1": 0.7, "y1": 0.9})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["roi"], {"x0": 0.3, "y0": 0.2, "x1": 0.7, "y1": 0.9})

        invalid = self.client.post("/api/growth/roi", json={"x0": 0.7, "y0": 0.2, "x1": 0.3, "y1": 0.9})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(self.client.post("/api/growth/calibrate", json={}).status_code, 409)

    def test_growth_reference_calibration_persists_and_calculates_actual_growth(self):
        self.client.post("/login", data={"username": "tester", "password": "correct-horse-battery-staple"})
        from app.database import add_photo
        filename = "reference.jpg"
        with open(os.path.join(self.temp.name, "photos", filename), "wb") as image:
            image.write(b"original-photo")
        add_photo(filename, analysis={"growth_score": .2,
                  "analysis_json": '{"valid":true,"surface_y_ratio":0.75,"confidence":0.9}'})
        from app.database import connect
        with connect() as db:
            photo_id = db.execute("SELECT id FROM photos ORDER BY id DESC LIMIT 1").fetchone()[0]
        response = self.client.post("/api/growth/calibration", json={
            "photo_id": photo_id, "left_x": .2, "right_x": .8,
            "bottom_y": .95, "initial_surface_y": .75})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["calibration"]["left_x"], .2)
        self.assertTrue(response.json["calibration"]["saved_at"])
        state = self.client.get(f"/api/growth?photo_id={photo_id}")
        self.assertEqual(state.status_code, 200)
        self.assertEqual(state.json["growth_percent"], 0.0)
        self.assertEqual(state.json["growth_factor"], 1.0)
        self.assertEqual(state.json["calibration"]["left_x"], .2)
        self.assertEqual(state.json["calibration"]["right_x"], .8)
        from app.database import growth_config
        roi = growth_config()["roi"]
        self.assertLess(roi["y0"], .75)
        self.assertEqual(roi["y1"], .95)
        self.assertEqual(self.client.delete("/api/growth/calibration").status_code, 200)
        self.assertIsNone(self.client.get("/api/growth").json["calibration"])

    def test_growth_history_keeps_invalid_camera_frames_for_chart_gaps(self):
        from app.database import add_photo, growth_history
        add_photo("valid.jpg", analysis={"growth_score": .2,
                  "analysis_json": '{"valid":true,"surface_y_ratio":0.75}'})
        add_photo("unclear.jpg", analysis={"growth_score": None,
                  "analysis_json": '{"valid":false,"reason":"no_surface_transition"}'})
        rows = growth_history()
        self.assertEqual(len(rows), 2)
        self.assertIsNone(rows[0]["growth_score"])
        self.assertIn('"valid":false', rows[0]["analysis_json"])

    def test_photo_api_accepts_a_time_window_without_removing_other_photos(self):
        self.client.post("/login", data={"username": "tester", "password": "correct-horse-battery-staple"})
        from app.database import add_photo
        add_photo("one.jpg")
        all_rows = self.client.get("/api/photos?limit=5000")
        self.assertEqual(all_rows.status_code, 200)
        self.assertEqual(len(all_rows.json), 1)
        self.assertEqual(self.client.get("/api/photos?start=bad").status_code, 400)

    def test_session_export_endpoints_reuse_login(self):
        self.assertEqual(self.client.get("/api/sessions").status_code, 401)
        self.client.post("/login", data={"username": "tester", "password": "correct-horse-battery-staple"})
        from app.database import add_photo, add_reading
        filename = "20261017-120000.jpg"
        with open(os.path.join(self.temp.name, "photos", filename), "wb") as image:
            image.write(b"original-jpeg")
        add_reading(25.2, 61.0)
        add_photo(filename)

        sessions = self.client.get("/api/sessions")
        self.assertEqual(sessions.status_code, 200)
        session = sessions.json["sessions"][0]
        self.assertTrue(session["inferred"])
        self.assertEqual(len(self.client.get(f"/api/sessions/{session['id']}/readings").json), 1)
        photos = self.client.get(f"/api/sessions/{session['id']}/photos")
        self.assertEqual(photos.status_code, 200)
        self.assertEqual(photos.json[0]["photo_url"], f"/photos/{filename}")
        exported = self.client.get(f"/api/sessions/{session['id']}/export")
        self.assertEqual(exported.status_code, 200)
        self.assertEqual(exported.mimetype, "application/zip")
        self.assertIn("attachment;", exported.headers["Content-Disposition"])
        self.assertEqual(self.client.get("/api/sessions/not-a-session/readings").status_code, 404)

    def test_fermentation_records_link_new_observations_and_read_api_is_independent(self):
        self.assertEqual(self.client.get("/api/v1/status").status_code, 401)
        self.client.post("/login", data={"username": "tester", "password": "correct-horse-battery-staple"})
        started = self.client.post("/api/fermentations", json={
            "starter_mass_g": "100", "flour_g": "100", "water_g": "50",
            "flour_type": "Manitoba", "hydration_pct": "50", "initial_ph": "4.2",
            "initial_dough_temp_c": "25.5", "target_fermenter_temp_c": "27"})
        self.assertEqual(started.status_code, 201)
        fermentation_id = started.json["id"]
        from app.database import start_fermentation
        with self.assertRaises(ValueError):
            start_fermentation({})

        from app.database import add_photo, add_reading
        filename = "test-fermentation.jpg"
        with open(os.path.join(self.temp.name, "photos", filename), "wb") as image:
            image.write(b"original-jpeg")
        add_reading(26.1, 62.0)
        add_photo(filename)
        event = self.client.post("/api/events", json={"event_type": "refresh", "starter_mass_g": 100,
                                                       "flour_g": 100, "water_g": 50,
                                                       "ph": 4.0, "details": "Refresc manual"})
        self.assertEqual(event.status_code, 201)
        token_headers = {"Authorization": "Bearer read-only-token-with-enough-entropy-for-tests"}
        self.assertEqual(self.client.get("/api/v1/status").status_code, 401)
        readings = self.client.get(f"/api/v1/readings?fermentation_id={fermentation_id}", headers=token_headers)
        photos = self.client.get(f"/api/v1/photos?fermentation_id={fermentation_id}", headers=token_headers)
        events = self.client.get(f"/api/v1/events?fermentation_id={fermentation_id}", headers=token_headers)
        self.assertEqual(readings.status_code, 200)
        self.assertEqual(readings.json["items"][0]["fermentation_id"], fermentation_id)
        self.assertEqual(photos.json["items"][0]["fermentation_id"], fermentation_id)
        self.assertGreaterEqual(len(events.json["items"]), 2)
        photo_id = photos.json["items"][0]["id"]
        image = self.client.get(f"/api/v1/photos/{photo_id}/image", headers=token_headers)
        self.assertEqual(image.data, b"original-jpeg")
        image.close()
        self.assertEqual(self.client.post("/api/v1/events", headers=token_headers, json={}).status_code, 405)

        ended = self.client.post(f"/api/fermentations/{fermentation_id}/end")
        self.assertEqual(ended.status_code, 200)
        self.assertIsNotNone(ended.json["ended_at"])
        detail = self.client.get(f"/api/v1/fermentations/{fermentation_id}", headers=token_headers)
        self.assertEqual(detail.json["counts"]["readings"], 1)
        exported = self.client.get(f"/api/v1/fermentations/{fermentation_id}/export", headers=token_headers)
        self.assertEqual(exported.status_code, 200)
        self.assertEqual(exported.mimetype, "application/zip")
        web_export = self.client.get(f"/api/fermentations/{fermentation_id}/export")
        self.assertEqual(web_export.status_code, 200)
        self.assertEqual(web_export.mimetype, "application/zip")


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

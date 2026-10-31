import unittest
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class CameraUiAssetTests(unittest.TestCase):
    def test_sampling_control_is_in_photo_history_header(self):
        html = (ROOT / "app/templates/dashboard.html").read_text()
        start = html.index('<section class="panel photo-panel">')
        end = html.index("</section>", start)
        section = html[start:end]
        self.assertIn('Mostrar una foto cada', section)
        self.assertIn('id="photo-sampling"', section)
        self.assertIn('value="10" selected', section)
        self.assertNotIn('id="photo-sampling"', html[html.index('<div class="camera-tools">'):html.index('</div>', html.index('<div class="camera-tools">'))])

    def test_calibration_controls_have_thin_visible_lines_and_mobile_layout(self):
        css = (ROOT / "app/static/app.css").read_text()
        self.assertIn(".guide.vertical:before", css)
        self.assertIn("width:2px;background:#2882d5", css)
        self.assertIn("height:2px;background:#dc4d40", css)
        self.assertIn(".camera-display-grid{grid-template-columns:1fr}", css)
        self.assertIn(".photo-sampling-control", css)

    def test_reference_selection_clamps_library_and_chart_gaps_survive(self):
        javascript = (ROOT / "app/static/app.js").read_text()
        self.assertIn("if(rebuild)renderPhotoLibrary(allPhotos)", javascript)
        self.assertIn("if(!Number.isFinite(row.growth_score)){penDown=false;return;}", javascript)
        self.assertIn("$('baseline-button').disabled=!photo", javascript)

    def test_camera_workflow_is_split_into_named_sections_and_uses_versioned_state_module(self):
        html = (ROOT / "app/templates/dashboard.html").read_text()
        self.assertNotIn("Període de visualització", html)
        self.assertIn("Comparació i evolució", html)
        self.assertIn("Reproducció de l’evolució", html)
        self.assertIn('id="calibration-feedback"', html)
        self.assertIn("camera-state.js?v={{ app_version }}", html)
        self.assertIn('id="camera-fermentation"', html)
        self.assertNotIn('id="camera-range"', html)
        self.assertIn('id="growth-overlay"', html)

    def test_manual_surface_editor_and_calibration_controls_are_present(self):
        html = (ROOT / "app/templates/dashboard.html").read_text()
        css = (ROOT / "app/static/app.css").read_text()
        javascript = (ROOT / "app/static/app.js").read_text()
        self.assertIn('id="manual-surface-line"', html)
        self.assertIn('id="manual-correction-save"', html)
        self.assertIn('<details class="calibration-settings">', html)
        self.assertIn('overflow:clip', css)
        self.assertIn('env(safe-area-inset-bottom)', css)
        self.assertIn('id="timeline-markers"', html)
        self.assertIn('function detectionExplanation', javascript)
        self.assertIn("/api/growth/manual/", javascript)

    def test_dashboard_exposes_data_freshness_errors_and_an_accessible_chart_table(self):
        html = (ROOT / "app/templates/dashboard.html").read_text()
        javascript = (ROOT / "app/static/app.js").read_text()
        self.assertIn('id="sensor-freshness"', html)
        self.assertIn('id="dashboard-refresh"', html)
        self.assertIn('id="dashboard-feedback"', html)
        self.assertIn('aria-describedby="chart-description"', html)
        self.assertIn('id="chart-data-body"', html)
        self.assertIn("renderReadingFreshness", javascript)
        self.assertIn("Darrera captura antiga", javascript)
        self.assertIn("l’últim intent ha fallat", javascript)

    def test_unified_session_chart_and_photo_timeline_use_versioned_state(self):
        html = (ROOT / "app/templates/dashboard.html").read_text()
        worker = (ROOT / "app/static/service-worker.js").read_text()
        javascript = (ROOT / "app/static/app.js").read_text()
        self.assertIn('chart-state.js?v={{ app_version }}', html)
        self.assertIn('/static/chart-state.js?v=${VERSION}', worker)
        for identifier in ('chart-session','simple-photo-timeline','chart-tooltip'):
            self.assertIn(f'id="{identifier}"', html)
        self.assertNotIn('id="chart-tooltip-close"', html)
        self.assertNotIn('id="simple-photo-latest"', html)
        self.assertNotIn('Evolució de les fotografies', html)
        self.assertNotIn('Les escales són diferents', html)
        self.assertIn('data-chart-series="growth"', html)
        self.assertIn("window.addEventListener('pageshow',refreshOnForeground)", javascript)
        self.assertIn("document.addEventListener('visibilitychange'", javascript)
        self.assertIn('fermentation_id=${encodeURIComponent(session.id)}', javascript)
        self.assertIn("simplePhotoRows[simplePhotoIndex]", javascript)

    def test_mobile_dashboard_uses_one_column_and_touch_sized_controls(self):
        css = (ROOT / "app/static/app.css").read_text()
        self.assertIn(".metrics{grid-template-columns:minmax(0,1fr);gap:8px}", css)
        self.assertIn("@media(max-width:380px)", css)
        self.assertIn(".secondary-button,.logout,button,select,input:not([type=checkbox]){min-height:44px", css)
        self.assertIn(".chart-data-table", css)

    def test_private_apis_and_photos_remain_excluded_from_service_worker_cache(self):
        worker = (ROOT / "app/static/service-worker.js").read_text()
        self.assertIn("url.pathname.startsWith('/api/')", worker)
        self.assertIn("url.pathname.startsWith('/photos/')", worker)

    def test_phone_and_desktop_camera_layout_rules_exist(self):
        css = (ROOT / "app/static/app.css").read_text()
        self.assertIn("grid-template-columns:repeat(2,minmax(0,1fr))", css)
        self.assertIn(".camera-display-grid{grid-template-columns:1fr}", css)
        self.assertIn(".camera-nav{display:grid;grid-template-columns:1fr 1fr}", css)

    def test_simple_mode_has_three_main_sections_and_hides_technical_home(self):
        html = (ROOT / "app/templates/dashboard.html").read_text()
        css = (ROOT / "app/static/simple-mode.css").read_text()
        for label in ("Inici", "Històric", "Ajustos", "Iniciar fermentació",
                      "Finalitzar fermentació", "Afegir nota", "Temperatura de la cambra"):
            self.assertIn(label, html)
        self.assertIn('id="fermentation-wizard"', html)
        self.assertIn('id="simple-finished"', html)
        self.assertIn('role="alert"', html)
        self.assertIn('data-mode-nav="advanced"', html)
        self.assertIn('#page-home > :not(.simple-home)', css)
        self.assertIn('grid-template-columns: repeat(3,minmax(0,1fr))', css)
        self.assertIn('#page-fermentations .history-item details', css)

    def test_mode_switch_is_delegated_and_mobile_nav_has_one_safe_area_reservation(self):
        theme = (ROOT / "app/static/theme.js").read_text()
        app_js = (ROOT / "app/static/app.js").read_text()
        css = (ROOT / "app/static/app.css").read_text()
        simple_css = (ROOT / "app/static/simple-mode.css").read_text()
        self.assertIn("event.target?.id === 'ui-mode-preference'", theme)
        self.assertIn("panettone:modechange", app_js)
        self.assertNotIn("$('ui-mode-preference').addEventListener", app_js)
        self.assertIn("min-height:48px", css)
        self.assertIn("max(4px,env(safe-area-inset-bottom))", css)
        self.assertIn("calc(64px + env(safe-area-inset-bottom))", css)
        self.assertNotIn("calc(88px + env(safe-area-inset-bottom))", simple_css)

    @unittest.skipUnless(shutil.which("node"), "Node.js is unavailable")
    def test_frontend_regressions_in_node(self):
        subprocess.run(["node", "--test", str(ROOT / "tests/camera_state.test.js"),
                        str(ROOT / "tests/probe-chart.test.js"),
                        str(ROOT / "tests/chart_state.test.js"),
                        str(ROOT / "tests/dashboard-state.test.js"),
                        str(ROOT / "tests/theme.test.js")],
                       check=True, cwd=ROOT, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()

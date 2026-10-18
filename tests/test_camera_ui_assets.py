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
        self.assertIn("if(rebuild&&allPhotos.length)renderPhotoLibrary(allPhotos)", javascript)
        self.assertIn("if(!Number.isFinite(row.growth_score)){penDown=false;return;}", javascript)
        self.assertIn("$('baseline-button').disabled=!selected", javascript)

    def test_camera_workflow_is_split_into_named_sections_and_uses_versioned_state_module(self):
        html = (ROOT / "app/templates/dashboard.html").read_text()
        self.assertIn("Període de visualització", html)
        self.assertIn("Comparació de fotografies", html)
        self.assertIn("Reproducció de l’evolució", html)
        self.assertIn('id="calibration-feedback"', html)
        self.assertIn("camera-state.js?v=0.8.2", html)
        self.assertIn('value="12"', html)
        period = html[html.index('id="camera-range"'):html.index('</select>', html.index('id="camera-range"'))]
        self.assertNotIn('value="all"', period)

    def test_phone_and_desktop_camera_layout_rules_exist(self):
        css = (ROOT / "app/static/app.css").read_text()
        self.assertIn("grid-template-columns:repeat(2,minmax(0,1fr))", css)
        self.assertIn(".camera-display-grid{grid-template-columns:1fr}", css)
        self.assertIn(".camera-nav{display:grid;grid-template-columns:1fr 1fr}", css)

    @unittest.skipUnless(shutil.which("node"), "Node.js is unavailable")
    def test_camera_state_regressions_in_node(self):
        subprocess.run(["node", "--test", str(ROOT / "tests/camera_state.test.js")],
                       check=True, cwd=ROOT, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()

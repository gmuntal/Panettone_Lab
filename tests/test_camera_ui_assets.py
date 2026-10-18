import unittest
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


if __name__ == "__main__":
    unittest.main()

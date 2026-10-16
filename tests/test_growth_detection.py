import unittest

from app.growth_detection import DEFAULT_ROI, estimate_surface


class GrowthDetectionTests(unittest.TestCase):
    def test_detects_sustained_dark_to_bright_surface(self):
        profile = [0.08] * 90 + [0.88] * 70
        result = estimate_surface(profile)
        self.assertIsNotNone(result)
        self.assertGreater(result['confidence'], 0.7)
        self.assertAlmostEqual(result['height_ratio'], 0.44, delta=0.04)

    def test_ignores_flat_profile(self):
        self.assertIsNone(estimate_surface([0.4] * 160))

    def test_ignores_short_profile(self):
        self.assertIsNone(estimate_surface([0.1, 0.9] * 10))

    def test_default_roi_is_normalized_and_has_usable_size(self):
        self.assertTrue(all(0 <= value <= 1 for value in DEFAULT_ROI.values()))
        self.assertGreaterEqual(DEFAULT_ROI['x1'] - DEFAULT_ROI['x0'], 0.06)
        self.assertGreaterEqual(DEFAULT_ROI['y1'] - DEFAULT_ROI['y0'], 0.12)


if __name__ == '__main__':
    unittest.main()

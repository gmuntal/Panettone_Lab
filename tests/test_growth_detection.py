import unittest

from app.growth_detection import DEFAULT_ROI, estimate_surface, growth_from_surface


class GrowthDetectionTests(unittest.TestCase):
    def test_growth_percent_is_relative_to_the_initial_height(self):
        self.assertEqual(growth_from_surface(.95, .75, .75), {"factor": 1.0, "percent": 0.0})
        self.assertEqual(growth_from_surface(.95, .75, .55), {"factor": 2.0, "percent": 100.0})
        self.assertEqual(growth_from_surface(.95, .75, .35), {"factor": 3.0, "percent": 200.0})

    def test_growth_rejects_invalid_guides(self):
        self.assertIsNone(growth_from_surface(.5, .7, .6))
        self.assertIsNone(growth_from_surface(.9, .8, 1.2))

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

    def test_skips_an_upper_reflection_and_uses_the_lower_surface(self):
        profile = [0.08] * 42 + [0.92] * 24 + [0.12] * 30 + [0.90] * 64
        result = estimate_surface(profile)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result['height_ratio'], 0.40, delta=0.04)

    def test_tracks_the_nearest_surface_transition(self):
        profile = [0.08] * 42 + [0.92] * 24 + [0.12] * 30 + [0.90] * 64
        result = estimate_surface(profile, previous_ratio=0.41)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result['height_ratio'], 0.40, delta=0.04)

    def test_default_roi_is_normalized_and_has_usable_size(self):
        self.assertTrue(all(0 <= value <= 1 for value in DEFAULT_ROI.values()))
        self.assertGreaterEqual(DEFAULT_ROI['x1'] - DEFAULT_ROI['x0'], 0.06)
        self.assertGreaterEqual(DEFAULT_ROI['y1'] - DEFAULT_ROI['y0'], 0.12)


if __name__ == '__main__':
    unittest.main()

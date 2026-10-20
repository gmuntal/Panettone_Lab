import json
import math
import os
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from app.calibrated_growth import _detect, analyze, prepare_reference
from app.growth_detection import growth_from_surface

CAL = dict(photo_id=1, left_x=.1, right_x=.9, bottom_y=.9, initial_surface_y=.75)


def synthetic(surface, light=0, irregular=False, glare=False):
    image = Image.new('L', (280, 400), 80 + light)
    pixels = image.load()
    for x in range(280):
        edge = round(surface*400) + (round(3*math.sin(x/12)) if irregular else 0)
        for y in range(edge, 360): pixels[x,y] = 215 + light
    if glare:
        for x in range(125,145):
            for y in range(360): pixels[x,y] = 250
    return image


class CalibratedGrowthTests(unittest.TestCase):
    def test_formula(self):
        for surface, expected in [(.75,0),(.675,50),(.6,100),(.45,200),(.8,-100/3)]:
            self.assertAlmostEqual(growth_from_surface(.9,.75,surface)['percent'], expected, delta=.1)

    def test_low_medium_high_irregular_glare_and_illumination(self):
        with tempfile.TemporaryDirectory() as folder:
            for surface in [.82,.68,.45]:
                for light,irregular,glare in [(0,False,False),(20,True,False),(-20,False,True)]:
                    with self.subTest(surface=surface,light=light):
                        path=Path(folder)/'image.png';synthetic(surface,light,irregular,glare).save(path)
                        result=analyze(path,CAL)
                        self.assertTrue(result['valid'],result)
                        self.assertAlmostEqual(result['surface_y_ratio'],surface,delta=.02)

    def test_no_contrast_is_not_a_measurement(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'blank.png';Image.new('L',(280,400),200).save(path)
            result=analyze(path,CAL)
            self.assertFalse(result['valid']);self.assertNotIn('percent',result)

    def test_temporal_prior_allows_a_fall_after_peak(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'fall.png';synthetic(.68).save(path)
            result=analyze(path,CAL,previous=.45)
            self.assertTrue(result['valid']);self.assertGreater(result['surface_y_ratio'],.65)

    def test_temporal_prior_does_not_reject_a_realistic_large_growth_without_elapsed_time(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'growth.png';synthetic(.60).save(path)
            result=analyze(path,CAL,previous=.75)
            self.assertTrue(result['valid'],result)
            self.assertLess(result['surface_y_ratio'],.65)

    def test_changed_geometry_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'image.png';synthetic(.75).save(path);reference=prepare_reference(path,CAL)
            synthetic(.6).resize((560,800)).save(path)
            self.assertEqual(analyze(path,CAL,reference)['reason'],'image_geometry_changed')

    def test_real_camera_profiles_low_intermediate_and_final(self):
        fixture=json.loads((Path(__file__).parent/'fixtures/real_growth_profiles.json').read_text())
        for frame in fixture['frames']:
            result=_detect(frame['profile'],fixture['calibration'],frame['previous'])
            self.assertTrue(result['valid'],frame['captured_at'])
            self.assertAlmostEqual(result['surface_y_ratio'],frame['expected_surface'],delta=.004)

    @unittest.skipUnless(os.getenv('PANETTONE_REAL_PHOTOS'),'Real photographs are optional local evidence')
    def test_entire_real_sequence(self):
        fixture=json.loads((Path(__file__).parent/'fixtures/real_growth_profiles.json').read_text())
        paths=sorted(Path(os.environ['PANETTONE_REAL_PHOTOS']).glob('*.jpg'))
        self.assertGreater(len(paths),100)
        reference=prepare_reference(paths[0],fixture['calibration']);previous=fixture['calibration']['initial_surface_y']
        for path in paths[1:]:
            result=analyze(path,fixture['calibration'],reference,previous)
            self.assertTrue(result['valid'],path.name);previous=result['surface_y_ratio']

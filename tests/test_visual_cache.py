import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from app import config, database, growth_analysis as service
from app.calibrated_growth import ALGORITHM_VERSION


class VisualCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.previous=database.settings
        database.settings=replace(config.settings,data_dir=self.temp.name,database_path=self.temp.name+'/test.db',photo_dir=self.temp.name+'/photos')
        database.init_db()
        with database.connect() as db:
            db.execute("INSERT INTO fermentations(id,started_at) VALUES(1,'2026-10-18T12:05:00+00:00')")
            db.execute("UPDATE fermentations SET ended_at='2026-10-18T14:00:00+00:00' WHERE id=1")
            db.execute("INSERT INTO fermentations(id,started_at) VALUES(2,'2026-10-18T14:01:00+00:00')")
            for ident,ferm,time in [(1,1,'12:06'),(2,1,'12:08'),(3,1,'12:10'),(4,2,'14:02')]:
                db.execute('INSERT INTO photos(id,captured_at,filename,camera_ok,fermentation_id) VALUES(?,?,?,?,?)',(ident,'2026-10-18T'+time+':00+00:00',f'{ident}.png',1,ferm))
                image=Image.new('L',(280,400),80);image.paste(215,(0,300,280,360));image.save(Path(database.settings.photo_dir)/f'{ident}.png')
        self.cal=dict(photo_id=1,left_x=.1,right_x=.9,bottom_y=.9,initial_surface_y=.75,captured_at='2026-10-18T12:06:00+00:00')
        service.save(self.cal,1)
    def tearDown(self):
        database.settings=self.previous;self.temp.cleanup()
    def test_reference_identity_and_fermentation_boundaries(self):
        result=service.sequence(1,enqueue=False)
        self.assertEqual(result['reference_id'],1);self.assertEqual(result['frames'][0]['measurement']['percent'],0)
        self.assertEqual([p['id'] for p in result['frames']],[1,2,3])
        with self.assertRaises(ValueError):service.sequence(1,4,False)
        self.assertEqual(service.sequence(2,enqueue=False)['reference_id'],4)
    def test_reference_changes_keep_earlier_photos_available(self):
        result=service.sequence(1,3,False)
        self.assertEqual(len(result['frames']),1);self.assertEqual(len(result['available_photos']),3)
        self.assertIsNone(result['calibration_signature'])
    def test_persistence_history_and_vessel_coordinates(self):
        service.save({**self.cal,'left_x':.12},1)
        database.init_db()
        cal,vessel=service.calibration_for(1);self.assertEqual(cal['left_x'],.12);self.assertEqual(vessel['left_x'],.12)
        service.reset(1)
        with database.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM visual_calibrations').fetchone()[0],2)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM photos').fetchone()[0],4)
            self.assertIsNone(db.execute('SELECT ended_at FROM fermentations WHERE id=2').fetchone()[0])
    def cache(self):
        seq=service.sequence(1,enqueue=False);thread=service._enqueue(1,self.cal,seq['calibration_signature'],seq['frames']);thread.join(5)
        self.assertFalse(thread.is_alive());return service.sequence(1,enqueue=False)
    def test_cache_reuse_calibration_algorithm_and_file_invalidation(self):
        cached=self.cache();self.assertEqual(cached['pending'],0)
        with patch.object(service,'analyze',side_effect=AssertionError('Must reuse persistent cache')):
            seq=service.sequence(1,enqueue=False);thread=service._enqueue(1,self.cal,seq['calibration_signature'],seq['frames']);thread.join(5)
        self.assertEqual(seq['pending'],0)
        with patch.object(service,'ALGORITHM_VERSION','future'):self.assertEqual(service.sequence(1,enqueue=False)['pending'],2)
        path=Path(database.settings.photo_dir)/'2.png';os.utime(path,ns=(path.stat().st_atime_ns,path.stat().st_mtime_ns+1))
        self.assertEqual(service.sequence(1,enqueue=False)['pending'],2)
        service.save({**self.cal,'left_x':.12},1)
        self.assertNotEqual(service.sequence(1,enqueue=False)['calibration_signature'],cached['calibration_signature'])
    def test_reference_file_change_invalidates_all_derived_measurements(self):
        before=self.cache();path=Path(database.settings.photo_dir)/'1.png';os.utime(path,ns=(path.stat().st_atime_ns,path.stat().st_mtime_ns+1))
        after=service.sequence(1,enqueue=False)
        self.assertNotEqual(before['calibration_signature'],after['calibration_signature']);self.assertEqual(after['pending'],2)
    def test_missing_image_is_unavailable_and_no_invented_percent(self):
        (Path(database.settings.photo_dir)/'2.png').unlink()
        result=self.cache()['frames'][1]['measurement'];self.assertFalse(result['valid']);self.assertNotIn('percent',result)
    def test_background_worker_is_deduplicated_and_does_not_call_devices(self):
        import threading
        wait=threading.Event();entered=threading.Event();original=service.prepare_reference
        def slow(*args):entered.set();wait.wait(3);return original(*args)
        with patch.object(service,'prepare_reference',side_effect=slow):
            seq=service.sequence(1,enqueue=False);thread=service._enqueue(1,self.cal,seq['calibration_signature'],seq['frames'])
            self.assertTrue(entered.wait(1));self.assertIsNone(service._enqueue(1,self.cal,seq['calibration_signature'],seq['frames']))
            self.assertEqual(service.sequence(1,enqueue=False)['pending'],2);wait.set();thread.join(5)
    def test_online_backup_migration_preserves_legacy_calibration(self):
        with database.connect() as db:
            db.execute('DROP TABLE visual_estimates');db.execute('DROP TABLE visual_calibrations')
            db.execute("INSERT INTO growth_settings VALUES('calibration',?)",(json.dumps(self.cal),))
        service.initialize();self.assertEqual(service.calibration_for(1)[0],self.cal)
        self.assertGreaterEqual(len(list((Path(self.temp.name)/'backups').glob('*.sqlite3'))),2)

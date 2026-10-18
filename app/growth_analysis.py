"""Versioned derived measurements; no camera, sensors or actuator calls."""
import hashlib
import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from datetime import datetime, timezone
from . import database
from .calibrated_growth import ALGORITHM_VERSION, prepare_reference, analyze

_lock=threading.Lock()
_jobs=set()


def initialize():
    with database.connect() as db:
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='visual_calibrations'").fetchone():return
        # Persistent online backup on the same volume. No original rows are rewritten.
        folder=Path(database.settings.data_dir)/'backups';folder.mkdir(exist_ok=True)
        destination=folder/('pre-visual-growth-'+str(time.time_ns())+'.sqlite3')
        with sqlite3.connect(destination) as backup:db.backup(backup)
        destination.chmod(0o600)
        db.executescript('''
        BEGIN IMMEDIATE;
        CREATE TABLE visual_calibrations(id INTEGER PRIMARY KEY AUTOINCREMENT,
          fermentation_id INTEGER REFERENCES fermentations(id),photo_id INTEGER NOT NULL REFERENCES photos(id),
          data TEXT NOT NULL,signature TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
        CREATE UNIQUE INDEX visual_active_calibration ON visual_calibrations(COALESCE(fermentation_id,0)) WHERE active=1;
        CREATE TABLE visual_estimates(photo_id INTEGER NOT NULL REFERENCES photos(id),
          fermentation_id INTEGER REFERENCES fermentations(id),signature TEXT NOT NULL,
          algorithm_version TEXT NOT NULL,image_stamp TEXT NOT NULL,data TEXT NOT NULL,
          PRIMARY KEY(photo_id,signature,algorithm_version));
        CREATE INDEX visual_estimates_sequence ON visual_estimates(fermentation_id,signature,algorithm_version);
        ''')
        old=db.execute("SELECT value FROM growth_settings WHERE key='calibration'").fetchone()
        if old:
            try:
                calibration=json.loads(old[0]);photo=db.execute('SELECT fermentation_id FROM photos WHERE id=?',(calibration['photo_id'],)).fetchone()
                if photo: _save(db,calibration,photo['fermentation_id'])
            except (ValueError,KeyError,TypeError):pass


def signature(calibration):
    return hashlib.sha256(json.dumps({k:calibration[k] for k in ['photo_id','left_x','right_x','bottom_y','initial_surface_y']},sort_keys=True).encode()).hexdigest()


def _save(db,calibration,fermentation_id):
    db.execute('UPDATE visual_calibrations SET active=0 WHERE fermentation_id IS ? AND active=1',(fermentation_id,))
    db.execute('INSERT INTO visual_calibrations(fermentation_id,photo_id,data,signature) VALUES(?,?,?,?)',
        (fermentation_id,calibration['photo_id'],json.dumps(calibration),signature(calibration)))
    vessel={k:calibration[k] for k in ['left_x','right_x','bottom_y']}
    db.execute("INSERT INTO growth_settings VALUES('vessel_calibration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps(vessel),))


def save(calibration,fermentation_id):
    with database.connect() as db:_save(db,calibration,fermentation_id)


def reset(fermentation_id):
    with database.connect() as db:db.execute('UPDATE visual_calibrations SET active=0 WHERE fermentation_id IS ?',(fermentation_id,))


def calibration_for(fermentation_id):
    with database.connect() as db:
        row=db.execute('SELECT data FROM visual_calibrations WHERE fermentation_id IS ? AND active=1',(fermentation_id,)).fetchone()
        vessel=db.execute("SELECT value FROM growth_settings WHERE key='vessel_calibration'").fetchone()
    return (json.loads(row[0]) if row else None,json.loads(vessel[0]) if vessel else None)


def photo_path(photo):
    name=photo['filename']
    if not name or Path(name).name!=name:raise ValueError('invalid_photo_path')
    return Path(database.settings.photo_dir)/name


def stamp(photo):
    try:
        info=photo_path(photo).stat();return f'{info.st_size}:{info.st_mtime_ns}'
    except (OSError,ValueError):return 'missing'


def context_stamps(photos,key):
    chain=key or ''
    result={}
    for photo in photos:
        chain=hashlib.sha256((chain+str(photo['id'])+photo['captured_at']+str(photo['camera_ok'])+stamp(photo)).encode()).hexdigest()
        result[photo['id']]=chain
    return result


def sequence(fermentation_id,reference_id=None,enqueue=True):
    calibration,vessel=calibration_for(fermentation_id)
    with database.connect() as db:
        fermentation=db.execute('SELECT * FROM fermentations WHERE id=?',(fermentation_id,)).fetchone()
        if not fermentation:raise ValueError('unknown_fermentation')
        photos=[dict(r) for r in db.execute('SELECT id,captured_at,filename,camera_ok,fermentation_id,archived_at,archived_filename FROM photos WHERE fermentation_id=? AND captured_at>=? ORDER BY captured_at,id',(fermentation_id,fermentation['started_at']))]
    reference_id=reference_id or (calibration['photo_id'] if calibration else next((p['id'] for p in photos if p['camera_ok'] and p['filename']),None))
    ref=next((p for p in photos if p['id']==reference_id and p['camera_ok'] and p['filename']),None)
    if reference_id and ref is None:raise ValueError('reference_outside_fermentation')
    available=[{**p,'image_revision':hashlib.sha256(stamp(p).encode()).hexdigest()[:16]} for p in photos]
    if ref:photos=[p for p in photos if p['captured_at']>=ref['captured_at']]
    compatible=bool(calibration and ref and calibration['photo_id']==ref['id'])
    key=signature(calibration) if compatible else None
    reference_stamp=stamp(ref) if compatible else None
    fullkey=hashlib.sha256((key+':'+reference_stamp).encode()).hexdigest() if key else None
    cached={}
    if fullkey:
        with database.connect() as db:
            cached={r['photo_id']:dict(r) for r in db.execute('SELECT * FROM visual_estimates WHERE fermentation_id=? AND signature=? AND algorithm_version=?',(fermentation_id,fullkey,ALGORITHM_VERSION))}
    pending=[];frames=[];stamps=context_stamps(photos,fullkey)
    for photo in photos:
        row=cached.get(photo['id']);image_stamp=stamps[photo['id']]
        if photo.get('archived_at') and row:
            # Retain the previously calculated numeric result for historical
            # graphs even when an intermediate original is in the recovery ZIP.
            result={**json.loads(row['data']),'quality':'archived_analysis'}
        elif photo.get('archived_at'):
            result={'valid':False,'quality':'archived','reason':'original_photo_in_archive'}
        elif compatible and photo['id']==ref['id'] and stamp(ref)!='missing':
            result={'valid':True,'quality':'manual_reference','percent':0.,'factor':1.,'surface_y_ratio':calibration['initial_surface_y'],'height_ratio':calibration['bottom_y']-calibration['initial_surface_y']}
        elif not photo['camera_ok'] or not photo['filename']:
            result={'valid':False,'quality':'unavailable','reason':'capture_failed'}
        elif row and row['image_stamp']==image_stamp:result=json.loads(row['data'])
        else:
            result={'valid':False,'quality':'pending' if compatible else 'uncalibrated','reason':'pending' if compatible else 'calibration_required'}
            if compatible:pending.append(photo)
        frames.append({**photo,'measurement':result,'image_revision':hashlib.sha256(stamp(photo).encode()).hexdigest()[:16]})
    if pending and enqueue:_enqueue(fermentation_id,calibration,fullkey,photos)
    return {'fermentation_id':fermentation_id,'calibration':calibration,'vessel':vessel,'reference_id':reference_id,
            'calibration_signature':fullkey,'algorithm_version':ALGORITHM_VERSION,'frames':frames,'available_photos':available,
            'pending':len(pending),'valid':sum(p['measurement']['valid'] for p in frames),'total':len(frames)}


def _enqueue(fermentation_id,calibration,key,photos):
    # A single low-impact analysis worker; separate from all periodic controllers.
    identity=(database.settings.database_path,fermentation_id,key)
    with _lock:
        if identity in _jobs or len(_jobs)>=4:return
        _jobs.add(identity)
    settings=database.settings
    def work():
        try:
            if database.settings is not settings:return
            reference=next(p for p in photos if p['id']==calibration['photo_id'])
            try:prepared=prepare_reference(photo_path(reference),calibration)
            except (OSError,ValueError):prepared=None
            previous=calibration['initial_surface_y'];stamps=context_stamps(photos,key);seen_milestones=set()
            with database.connect() as db:
                cached={r['photo_id']:dict(r) for r in db.execute('SELECT photo_id,data,image_stamp FROM visual_estimates WHERE signature=? AND algorithm_version=?',(key,ALGORITHM_VERSION))}
            for prior in photos:
                if prior['id']==calibration['photo_id']:
                    continue
                prior_row=cached.get(prior['id'])
                if prior_row:
                    try:
                        prior_result=json.loads(prior_row['data'])
                        if prior_result.get('valid'):
                            for threshold in (100,200):
                                if prior_result.get('percent',0)>=threshold:seen_milestones.add(threshold)
                    except (TypeError,ValueError):
                        pass
            for photo in photos:
                if database.settings is not settings:return
                image_stamp=stamps[photo['id']];old=cached.get(photo['id'])
                if old and old['image_stamp']==image_stamp:
                    result=json.loads(old['data'])
                    if result['valid']:previous=result['surface_y_ratio']
                    continue
                current,_=calibration_for(fermentation_id)
                if current is None or signature(current)!=signature(calibration):return
                if photo['id']==calibration['photo_id'] and prepared:
                    result={'valid':True,'quality':'manual_reference','percent':0.,'factor':1.,'surface_y_ratio':calibration['initial_surface_y'],'height_ratio':calibration['bottom_y']-calibration['initial_surface_y']}
                else:
                    try:
                        result=analyze(photo_path(photo),calibration,prepared,previous) if prepared else {'valid':False,'quality':'unavailable','reason':'reference_image_unavailable'}
                    except (OSError,ValueError):result={'valid':False,'quality':'unavailable','reason':'image_unavailable'}
                if result['valid']:previous=result['surface_y_ratio']
                with database.connect() as db:
                    db.execute('INSERT INTO visual_estimates VALUES(?,?,?,?,?,?) ON CONFLICT(photo_id,signature,algorithm_version) DO UPDATE SET image_stamp=excluded.image_stamp,data=excluded.data',
                        (photo['id'],fermentation_id,key,ALGORITHM_VERSION,image_stamp,json.dumps(result)))
                    active=db.execute('SELECT ended_at FROM fermentations WHERE id=?',(fermentation_id,)).fetchone()
                    monitoring=db.execute('SELECT active FROM monitoring_control WHERE id=1').fetchone()
                if result.get('valid') and active and active['ended_at'] is None and monitoring and monitoring[0]:
                    try:
                        age=(datetime.now(timezone.utc)-datetime.fromisoformat(photo['captured_at'].replace('Z','+00:00'))).total_seconds()
                    except (TypeError,ValueError):
                        age=float('inf')
                    if 0<=age<=max(300,database.settings.photo_interval_seconds*3):
                        for threshold,label in ((100,'duplicada'),(200,'triplicada')):
                            if threshold not in seen_milestones and result.get('percent',0)>=threshold:
                                try:
                                    from .push import enqueue
                                    enqueue('fermentation',f'Massa {label}',
                                            f'La detecció visual estima un creixement del {result["percent"]:.0f}% respecte de la referència.',
                                            f'growth-milestone:{fermentation_id}:{threshold}')
                                except Exception:
                                    pass
                            if result.get('percent',0)>=threshold:seen_milestones.add(threshold)
                time.sleep(.025)
        except (sqlite3.Error,OSError):
            # A removed test DB or temporarily unavailable filesystem must not
            # affect device workers; the next request can retry the cache job.
            pass
        finally:
            with _lock:_jobs.discard(identity)
    # Never parallelize batches, including obsolete calibrations being cancelled.
    def serialized():
        with _worker_lock:work()
    thread=threading.Thread(target=serialized,name='visual-analysis',daemon=True);thread.start();return thread

_worker_lock=threading.Lock()

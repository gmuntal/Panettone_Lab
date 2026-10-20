"""Calibrated height analysis, independent of capture and thermal control.

Quality indicators describe image evidence, never statistical confidence.
"""
import math
from statistics import median
from PIL import Image
from .growth_detection import growth_from_surface

ALGORITHM_VERSION = 'calibrated-stripes-2'


def profiles(path, calibration):
    with Image.open(path) as source:
        size = source.size
        image = source.convert('L')
        width = min(640, image.width)
        image = image.resize((width, max(32, round(image.height * width / image.width))), Image.Resampling.BILINEAR)
        height = image.height
        left, right = (round(calibration[k] * width) for k in ('left_x','right_x'))
        # Ignore the curved glass walls, retaining multiple independent interior strips.
        inset = max(1, round((right-left)*.16));left+=inset;right-=inset
        if right-left<14:raise ValueError('jar_too_narrow')
        pixels=image.load();bands=[]
        for n in range(7):
            a=left+(right-left)*n//7;b=left+(right-left)*(n+1)//7
            bands.append([sum(pixels[x,y] for x in range(a,b))/max(1,b-a) for y in range(height)])
    return {'bands':bands,'height':height,'image_size':size}


def _detect(frame, calibration, previous=None):
    bands=frame['bands'];height=frame['height']
    bottom=round(calibration['bottom_y']*height)
    initial=(calibration['bottom_y']-calibration['initial_surface_y'])*height
    start=max(2,round(bottom-5*initial));stop=min(height-3,bottom-3)
    window=max(2,min(7,round(initial*.15)))
    if stop-start<12:return {'valid':False,'quality':'unavailable','reason':'insufficient_vertical_resolution'}
    candidates=[]
    for values in bands:
        smooth=[sum(values[max(0,y-1):y+2])/len(values[max(0,y-1):y+2]) for y in range(height)]
        body=smooth[max(start,bottom-max(4,round(initial*.55))):max(start+1,bottom-2)]
        if not body:continue
        body_level=median(body)
        # Calibrated bottom is occupied by dough. Derive its brightness per image,
        # rather than treating a globally bright IR reflection as dough.
        region=sorted(smooth[start:stop]);air=region[max(0,len(region)//5)]
        span=body_level-air
        if span<12:continue
        threshold=body_level-max(8,min(30,span*.22))
        prefix=[0.]
        bright=[0]
        for v in smooth:prefix.append(prefix[-1]+v);bright.append(bright[-1]+int(v>=threshold))
        options=[]
        for y in range(start+window,stop-window):
            above=(prefix[y]-prefix[y-window])/window
            below=(prefix[y+window+1]-prefix[y+1])/window
            contrast=below-above
            # Reject small bright bands/reflections which do not continue into
            # the known dough body. Keep validity criteria separate from ranking.
            length=max(1,bottom-y-window)
            occupancy=(bright[bottom]-bright[y+window])/length
            if contrast<max(5,span*.09) or below<threshold-12 or occupancy<.78:continue
            continuity=0 if previous is None else min(.4,abs(y/height-previous))
            options.append((contrast/span-continuity*.3,y,contrast,occupancy))
        if options:
            _,y,contrast,occupancy=max(options)
            candidates.append((y,contrast,occupancy))
    if len(candidates)<4:
        return {'valid':False,'quality':'unavailable','reason':'insufficient_spatial_support',
                'support':round(len(candidates)/7,3),'evidence':'edge_not_continuous_across_interior_bands'}
    center=median(c[0] for c in candidates)
    spread=median(abs(c[0]-center) for c in candidates)
    agreeing=[c for c in candidates if abs(c[0]-center)<=max(4,initial*.16)]
    if len(agreeing)<4 or spread>max(5,initial*.18):
        return {'valid':False,'quality':'uncertain','reason':'ambiguous_surface',
                'support':round(len(agreeing)/7,3),'surface_spread_pixels':round(spread,2),
                'evidence':'candidate_edges_disagree_between_interior_bands'}
    surface=median(c[0] for c in agreeing)/height
    # The prior is used to rank plausible candidates, never to reject a real
    # fall. A rate limit needs the timestamp delta and should be applied by the
    # sequence layer; _detect alone cannot distinguish a 2-minute jump from a
    # multi-hour fermentation change.
    return {'valid':True,'quality':'correct','reason':None,'surface_y_ratio':round(surface,6),
            'support':round(len(agreeing)/7,3),'edge_contrast':round(median(c[1] for c in agreeing),2),'surface_spread_pixels':round(spread,2)}


def prepare_reference(path, calibration):
    frame=profiles(path,calibration)
    detected=_detect(frame,calibration,calibration['initial_surface_y'])
    offset=calibration['initial_surface_y']-detected['surface_y_ratio'] if detected['valid'] else 0.
    # A large mismatch is not a licence to shift every measurement artificially.
    if abs(offset)>.04:offset=0.
    return {'frame':frame,'offset':offset,'detected':detected}


def analyze(path, calibration, reference=None, previous=None):
    frame=profiles(path,calibration)
    if reference and frame['image_size']!=reference['frame']['image_size']:
        return {'valid':False,'quality':'unavailable','reason':'image_geometry_changed'}
    result=_detect(frame,calibration,previous)
    if not result['valid']:return result
    result['raw_surface_y_ratio']=result['surface_y_ratio']
    result['reference_offset']=round(reference['offset'],6) if reference else 0
    result['surface_y_ratio']=round(result['surface_y_ratio']+result['reference_offset'],6)
    growth=growth_from_surface(calibration['bottom_y'],calibration['initial_surface_y'],result['surface_y_ratio'])
    if growth is None:return {'valid':False,'quality':'unavailable','reason':'surface_outside_calibration'}
    return {**result,**growth,'height_ratio':round(calibration['bottom_y']-result['surface_y_ratio'],6),'algorithm_version':ALGORITHM_VERSION}

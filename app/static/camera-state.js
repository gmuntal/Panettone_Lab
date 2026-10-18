(function (root) {
  const api = {
    firstPhotoAtOrAfter(photos, timestamp) {
      const start = new Date(timestamp).getTime();
      if (!Number.isFinite(start)) return null;
      return photos.slice().sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))
        .find(photo => new Date(photo.captured_at).getTime() >= start) || null;
    },
    preservePhotoId(currentId, eligiblePhotos) {
      return eligiblePhotos.some(photo => String(photo.id) === String(currentId))
        ? currentId : (eligiblePhotos.at(-1)?.id ?? null);
    },
    nextPhotoId(currentId, eligiblePhotos) {
      const index = eligiblePhotos.findIndex(photo => String(photo.id) === String(currentId));
      return index >= 0 && index < eligiblePhotos.length - 1 ? eligiblePhotos[index + 1].id : currentId;
    },
    shouldHydrateCalibration(isDirty, ignoreServerCalibration) {
      return !isDirty && !ignoreServerCalibration;
    },
    calibrationMatches(saved, submitted, tolerance = 0.00001) {
      if (!saved || String(saved.photo_id) !== String(submitted.photo_id)) return false;
      return ['left_x', 'right_x', 'bottom_y', 'initial_surface_y']
        .every(key => Math.abs(Number(saved[key]) - Number(submitted[key])) <= tolerance);
    },
    isLatestRequest(sequence, latestSequence) {
      return sequence === latestSequence;
    }
  };
  root.PanettoneCameraState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
// Pure rules shared by the camera, graph, overlay and regression tests.
(function(root){
  const api=root.PanettoneCameraState;
  api.thresholdState=percent=>!Number.isFinite(percent)?'unavailable':percent>=200?'tripled':percent>=100?'doubled':'normal';
  api.series=(frames,reference,end)=>frames.filter(p=>new Date(p.captured_at)>=new Date(reference.captured_at)&&new Date(p.captured_at)<=new Date(end.captured_at)).map(p=>({...p,growth_score:p.measurement?.valid&&Number.isFinite(p.measurement.percent)?p.measurement.percent:null}));
  api.milestones=(series,reference)=>[100,200].map(threshold=>{
    const photo=series.find(p=>Number.isFinite(p.growth_score)&&p.growth_score>=threshold);
    return photo?{threshold,photo_id:photo.id,captured_at:photo.captured_at,elapsed_seconds:(new Date(photo.captured_at)-new Date(reference.captured_at))/1000,percent:photo.growth_score}:null;
  }).filter(Boolean);
  api.playbackFrames=(photos,endId)=>{
    const index=photos.findIndex(p=>String(p.id)===String(endId));return index<0?[]:photos.slice(0,index+1);
  };
  api.sample=(rows,minutes)=>{
    if(minutes==='all'||rows.length<2)return rows.slice().reverse();
    const result=[rows.at(-1)];let cutoff=new Date(rows.at(-1).captured_at).getTime()-Number(minutes)*60000;
    for(let i=rows.length-2;i>=0;i--)if(new Date(rows[i].captured_at).getTime()<=cutoff){result.push(rows[i]);cutoff=new Date(rows[i].captured_at).getTime()-Number(minutes)*60000;}
    return result;
  };
})(typeof window!=='undefined'?window:globalThis);

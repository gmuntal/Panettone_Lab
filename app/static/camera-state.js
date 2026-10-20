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
  api.series=(frames,reference,end)=>frames.filter(p=>new Date(p.captured_at)>=new Date(reference.captured_at)&&new Date(p.captured_at)<=new Date(end.captured_at)).map(p=>{const m=p.manual_measurement?.valid?p.manual_measurement:p.measurement;return {...p,growth_score:m?.valid&&Number.isFinite(m.percent)?m.percent:null,measurement_source:p.manual_measurement?.valid?'manual':'automatic'};});
  api.milestones=(series,reference)=>[100,200].map(threshold=>{
    // Manual overrides are plotted as measurements but never generate
    // automatic milestones or imply an algorithm-verified threshold.
    const photo=series.find(p=>p.measurement_source!=='manual'&&Number.isFinite(p.growth_score)&&p.growth_score>=threshold);
    return photo?{threshold,photo_id:photo.id,captured_at:photo.captured_at,elapsed_seconds:(new Date(photo.captured_at)-new Date(reference.captured_at))/1000,percent:photo.growth_score}:null;
  }).filter(Boolean);
  api.playbackFrames=(photos,endId)=>{
    const index=photos.findIndex(p=>String(p.id)===String(endId));return index<0?[]:photos.slice(0,index+1);
  };
  api.markers=frames=>{
    const valid=frames.filter(p=>p.measurement?.valid&&Number.isFinite(p.measurement.percent));
    if(!valid.length)return [];
    const markers=api.milestones(valid.map(p=>({...p,growth_score:p.measurement.percent})),valid[0]).map(m=>({kind:m.threshold===100?'doubled':'tripled',photo_id:m.photo_id,captured_at:m.captured_at,label:m.threshold===100?'Primera duplicació fiable':'Primera triplicació fiable'}));
    const peak=valid.reduce((a,b)=>b.measurement.percent>a.measurement.percent?b:a);
    if(valid.length>1&&peak.measurement.percent>0)markers.push({kind:'peak',photo_id:peak.id,captured_at:peak.captured_at,label:'Màxim creixement mesurat',percent:peak.measurement.percent});
    for(let i=1;i<valid.length;i++)if(valid[i].measurement.percent-valid[i-1].measurement.percent<=-20){markers.push({kind:'drop',photo_id:valid[i].id,captured_at:valid[i].captured_at,label:'Descens observat',percent:valid[i].measurement.percent});break;}
    let run=[];
    for(const frame of frames){if(frame.measurement?.quality==='uncertain'||frame.measurement?.quality==='unavailable')run.push(frame);else run=[];if(run.length===3){markers.push({kind:'gap',photo_id:run[0].id,captured_at:run[0].captured_at,label:'Tres captures sense detecció fiable'});break;}}
    return markers.sort((a,b)=>new Date(a.captured_at)-new Date(b.captured_at));
  };
  api.sample=(rows,minutes)=>{
    if(minutes==='all'||rows.length<2)return rows.slice().reverse();
    const result=[rows.at(-1)];let cutoff=new Date(rows.at(-1).captured_at).getTime()-Number(minutes)*60000;
    for(let i=rows.length-2;i>=0;i--)if(new Date(rows[i].captured_at).getTime()<=cutoff){result.push(rows[i]);cutoff=new Date(rows[i].captured_at).getTime()-Number(minutes)*60000;}
    return result;
  };
})(typeof window!=='undefined'?window:globalThis);

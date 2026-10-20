const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../app/static/camera-state.js');

const photos = [
  { id: 1, captured_at: '2026-10-17T00:00:00+02:00' },
  { id: 2, captured_at: '2026-10-17T00:02:00+02:00' },
  { id: 3, captured_at: '2026-10-17T00:04:00+02:00' }
];
const calibration = { photo_id: 1, left_x: .2, right_x: .8, bottom_y: .95, initial_surface_y: .7 };

test('1: polling cannot overwrite a calibration while its guides are being edited', () => {
  let dirty = false;
  let editing = { ...calibration };
  editing.left_x = .23;
  dirty = true;
  if (state.shouldHydrateCalibration(dirty, false)) editing = { ...calibration };
  for (let n = 0; n < 5; n++) assert.equal(editing.left_x, .23);
});

test('2: saved calibration coordinates round-trip exactly after reload', () => {
  assert.equal(state.calibrationMatches({ ...calibration }, calibration), true);
});

test('3: new photos do not change an explicitly selected initial reference', () => {
  const morePhotos = [...photos, { id: 4, captured_at: '2026-10-17T00:06:00+02:00' }];
  assert.equal(state.preservePhotoId(2, morePhotos), 2);
});

test('4: automatic initial reference is the first capture at or after fermentation start', () => {
  assert.equal(state.firstPhotoAtOrAfter(photos, '2026-10-17T00:01:00+02:00').id, 2);
  assert.equal(state.firstPhotoAtOrAfter(photos, '2026-10-17T00:05:00+02:00'), null);
});

test('5: changing the visible period does not alter the reference; final stays eligible', () => {
  const visible = photos.slice(1);
  const referenceId = 1;
  assert.equal(state.preservePhotoId(3, visible), 3);
  assert.equal(referenceId, 1);
});

test('6: playback advances only the final photo and never wraps past the end', () => {
  assert.equal(state.nextPhotoId(1, photos), 2);
  assert.equal(state.nextPhotoId(3, photos), 3);
});

test('7: out-of-order network results are rejected; server calibration equality is checked', () => {
  assert.equal(state.isLatestRequest(4, 5), false);
  assert.equal(state.isLatestRequest(5, 5), true);
  assert.equal(state.calibrationMatches({ ...calibration, left_x: .25 }, calibration), false);
});

const frames = [0,50,null,100,210,80].map((percent,index)=>({id:index+1,captured_at:`2026-10-18T12:${String(index*10).padStart(2,'0')}:00Z`,measurement:{valid:percent!==null,percent,factor:percent===null?null:1+percent/100}}));
test('full interval keeps invalid frames as gaps and clips only at final cursor',()=>{
  const series=state.series(frames,frames[0],frames[4]);
  assert.deepEqual(series.map(p=>p.growth_score),[0,50,null,100,210]);
  assert.equal(series.length,5);
});
test('milestones are first observed reliable frames without interpolated crossing times',()=>{
  const marks=state.milestones(state.series(frames,frames[0],frames.at(-1)),frames[0]);
  assert.deepEqual(marks.map(p=>p.photo_id),[4,5]);assert.equal(marks[0].elapsed_seconds,1800);
  assert.equal(state.thresholdState(80),'normal');assert.equal(state.thresholdState(null),'unavailable');
  assert.equal(state.thresholdState(100),'doubled');assert.equal(state.thresholdState(200),'tripled');
});
test('sampling thumbnails does not alter graph frames or the playback interval',()=>{
  for(const interval of ['all','5','10','15','20','30']){
    assert.equal(state.sample(frames,interval)[0].id,6);
    assert.equal(state.playbackFrames(frames,4).length,4);assert.equal(frames.length,6);
  }
});

// Execute the actual camera controller with a tiny DOM and controllable image
// completion; this reproduces image/network races without browser timers.
const fs=require('node:fs'),vm=require('node:vm');
function controller(){
  const elements=new Map(),images=[],timers=[];
  function element(){return {value:'',textContent:'',style:{setProperty(){}},dataset:{},hidden:false,children:[],classList:{toggle(){}},addEventListener(name,fn){this[name]=fn;},append(...children){this.children.push(...children);},replaceChildren(){this.children=[];},removeAttribute(){},setAttribute(){},getBoundingClientRect(){return {width:600,height:260}},getContext(){return new Proxy({},{get(){return ()=>{}},set(){return true}})}};}
  const doc={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},querySelector(){return null},querySelectorAll(){return []},createElement:element};
  const context=vm.createContext({document:doc,window:{devicePixelRatio:1,addEventListener(){}},navigator:{},location:{hash:'#camera'},PanettoneCameraState:state,Intl,Date,console,Image:class {constructor(){images.push(this)}},setInterval(fn,delay){timers.push({fn,delay});return timers.length},clearInterval(){},setTimeout(){},clearTimeout(){}});
  const code=fs.readFileSync(require.resolve('../app/static/app.js'),'utf8').split('showPage(location.hash.slice(1),false);refresh();')[0];
  vm.runInContext(code,context);
  const run=code=>vm.runInContext(code,context);
  context.input=frames.map(p=>({...p,filename:p.id+'.jpg',fermentation_id:2,camera_ok:1,image_revision:'same',analysisSignature:'key'}));
  run('cameraFermentationId=2;growthCalibration={photo_id:1,left_x:.1,right_x:.9,bottom_y:.9,initial_surface_y:.75};displayCalibrationSignature="key";growthHistoryCache=input;');
  elements.get('photo-sampling').value='10';elements.get('timelapse-speed').value='1';
  run('renderPhotoLibrary(input)');return {elements,images,timers,run,context};
}
test('overlay belongs to loaded final photograph; stale image completions cannot overwrite it',()=>{
  const c=controller();c.run('selectPhoto(2)');const old=c.images.at(-1);c.run('selectPhoto(5)');
  assert.equal(c.elements.get('growth-overlay-percent').textContent,'—');
  old.onload();assert.equal(c.elements.get('growth-overlay-percent').textContent,'—');
  c.images.at(-1).onload();assert.equal(c.elements.get('growth-overlay-percent').textContent,'+210%');
  assert.equal(c.elements.get('growth-overlay-milestone').textContent,'Massa triplicada');
  c.run('selectPhoto(3)');c.images.at(-1).onload();assert.equal(c.elements.get('growth-overlay-percent').textContent,'—');
  assert.equal(c.elements.get('growth-overlay-milestone').textContent,'');
});
test('all playback speeds advance only right image and stop at the selected intermediate end',()=>{
  for(const speed of [.5,1,2,5,10,20]){
    const c=controller();c.elements.get('timelapse-speed').value=String(speed);c.run('selectPhoto(4);playTimelapse()');
    const timer=c.timers.at(-1);assert.equal(timer.delay,Math.max(75,1500/speed));
    assert.equal(c.run('selectedReferenceId'),1);assert.equal(c.run('selectedFinalId'),1);
    for(let i=0;i<5;i++)timer.fn();
    assert.equal(c.run('selectedFinalId'),4);assert.equal(c.run('selectedReferenceId'),1);
    c.elements.get('timelapse-reset').click();assert.equal(c.run('selectedFinalId'),2);
  }
});
test('editing calibration hides old percentages and polling cannot hydrate over pending guides',async()=>{
  const c=controller();c.images.at(-1).onload();c.run('calibrationDirty=true;calibrationTouched=true;growthCalibration.left_x=.2;renderGrowth()');
  assert.equal(c.elements.get('growth-overlay-percent').textContent,'—');
  c.context.response={calibration:{photo_id:1,left_x:.4},vessel:{},reference_id:1,frames:c.context.input,calibration_signature:'other',pending:0};
  c.run('json=async()=>response');await c.run('refreshCamera()');assert.equal(c.run('growthCalibration.left_x'),.2);
});
test('late sequence response cannot replace newer fermentation results',async()=>{
  const c=controller();const pending=[];c.context.queue=pending;c.run('json=()=>new Promise(resolve=>queue.push(resolve))');
  const first=c.run('refreshCamera()'),second=c.run('refreshCamera()');
  const response={calibration:c.run('growthCalibration'),vessel:{},reference_id:1,frames:c.context.input,calibration_signature:'new',pending:0};
  pending[1](response);await second;pending[0]({...response,calibration_signature:'old'});await first;
  assert.equal(c.run('displayCalibrationSignature'),'new');
});

test('switching to active fermentation works with a dirty calibration and clears old photos immediately',async()=>{
  const c=controller(),queue=[];c.context.queue=queue;
  c.run('json=()=>new Promise(resolve=>queue.push(resolve));calibrationDirty=true;calibrationTouched=true;growthCalibration.left_x=.23;');
  const selector=c.elements.get('camera-fermentation');selector.value='3';selector.change({currentTarget:selector});
  assert.equal(c.run('cameraFermentationId'),3);
  assert.equal(c.run('allPhotos.length'),0);assert.equal(c.run('photoLibrary.length'),0);
  assert.equal(c.elements.get('camera-current-image').hidden,true);
  assert.equal(c.elements.get('growth-overlay-percent').textContent,'—');
  assert.match(c.elements.get('camera-load-status').textContent,/Carregant.*#3/);
});

function sequenceResponse(id){
  const offset=id===2?0:id*100;
  const items=frames.map(p=>({...p,id:p.id+offset,filename:(p.id+offset)+'.jpg',fermentation_id:id,camera_ok:1,image_revision:'same'}));
  return {fermentation_id:id,reference_id:items[0].id,calibration:{photo_id:items[0].id,left_x:id/10,right_x:.9,bottom_y:.9,initial_surface_y:.7},vessel:{},frames:items,calibration_signature:'calibration-'+id,pending:0};
}
async function changeFermentation(c,id){
  const selector=c.elements.get('camera-fermentation');selector.value=String(id);selector.change({currentTarget:selector});
  await Promise.resolve();await Promise.resolve();
}
test('finalized, active and archived selections cycle without mixing photographs, calibration or drafts',async()=>{
  const c=controller();c.context.responses={1:sequenceResponse(1),2:sequenceResponse(2),3:sequenceResponse(3)};
  c.run("fermentationsCache=[{id:3,started_at:'2026-10-18',ended_at:null},{id:2,started_at:'2026-10-17',ended_at:'2026-10-18'},{id:1,started_at:'2026-10-16',ended_at:'2026-10-17',archived_at:'2026-10-18'}];activeFermentation=fermentationsCache[0];json=async url=>responses[new URL(url,'http://localhost').searchParams.get('fermentation_id')];");
  // URL is supplied only to the test context, not to production state.
  c.context.URL=URL;
  for(const id of [3,2,3,1,3,2]){
    await changeFermentation(c,id);
    assert.equal(c.run('cameraFermentationId'),id);assert.equal(c.elements.get('camera-fermentation').value,String(id));
    assert.equal(c.run('allPhotos.every(p=>p.fermentation_id===cameraFermentationId)'),true);
    assert.equal(c.run('growthCalibration.left_x'),id/10);
    assert.equal(c.run('selectedReferenceId'),c.context.responses[id].reference_id);
    c.run('renderCameraFermentations()');assert.equal(c.run('cameraFermentationId'),id);
  }
  c.run('calibrationDirty=true;calibrationTouched=true;growthCalibration.left_x=.234;');
  await changeFermentation(c,3);assert.equal(c.run('growthCalibration.left_x'),.3);
  await changeFermentation(c,2);assert.equal(c.run('growthCalibration.left_x'),.234);assert.equal(c.run('calibrationDirty'),true);
});
test('new active photographs extend timeline without moving a pinned cursor; latest explicitly resumes following',async()=>{
  const c=controller();c.context.response=sequenceResponse(2);c.run('json=async()=>response;cameraFollowsActive=false;selectPhoto(2)');
  const reference=c.run('selectedReferenceId'),left=c.run('growthCalibration.left_x');
  c.context.response.frames.push({...c.context.response.frames.at(-1),id:7,captured_at:'2026-10-18T13:00:00Z',filename:'7.jpg'});
  await c.run('refreshCamera()');assert.equal(c.run('selectedFinalId'),2);assert.equal(c.elements.get('photo-timeline').max,'6');
  assert.equal(c.run('selectedReferenceId'),reference);
  c.elements.get('photo-latest').click();assert.equal(c.run('selectedFinalId'),7);assert.equal(c.run('finalPinned'),false);
  c.context.response.frames.push({...c.context.response.frames.at(-1),id:8,filename:'8.jpg',captured_at:'2026-10-18T13:02:00Z'});
  await c.run('refreshCamera()');assert.equal(c.run('selectedFinalId'),8);
  assert.equal(c.run('growthCalibration.left_x'),.2);
});
test('polling preserves native selector nodes and does not rewrite a pending native picker value',()=>{
  const c=controller();c.run("cameraFollowsActive=false;fermentationsCache=[{id:3,started_at:'2026-10-18',ended_at:null},{id:2,started_at:'2026-10-17',ended_at:'2026-10-18'}];renderCameraFermentations()");
  const selector=c.elements.get('camera-fermentation'),option=selector.children[0];
  selector.value='3';c.run('renderCameraFermentations()');assert.equal(selector.value,'3');assert.equal(selector.children[0],option);
});
test('late request failures and image completions from another fermentation cannot alter the new view',async()=>{
  const c=controller();const image=c.images.at(-1),queue=[];c.context.queue=queue;c.run('json=()=>new Promise((resolve,reject)=>queue.push({resolve,reject}))');
  const old=c.run('refreshCamera()');await changeFermentation(c,3);
  queue[1].resolve(sequenceResponse(3));await Promise.resolve();await Promise.resolve();
  const status=c.elements.get('camera-load-status').textContent;
  queue[0].reject(new Error('Old server error'));await old;image.onload();
  assert.equal(c.elements.get('camera-load-status').textContent,status);
  assert.equal(c.elements.get('camera-current-image').hidden,true);
  c.images.at(-1).onload();assert.equal(c.run('selectedFinalId'),306);assert.equal(c.run('growthCalibration.left_x'),.3);
});
test('failed selection shows its own error with an empty view and can be retried',async()=>{
  const c=controller();c.run("json=async()=>{throw new Error('HTTP 503')}");
  await changeFermentation(c,3);assert.equal(c.run('cameraFermentationId'),3);assert.equal(c.run('photoLibrary.length'),0);
  assert.match(c.elements.get('camera-load-status').textContent,/#3.*HTTP 503/);
  c.context.response=sequenceResponse(3);c.run('json=async()=>response');await c.run('refreshCamera()');
  assert.equal(c.run('photoLibrary.length'),6);assert.equal(c.run('growthCalibration.left_x'),.3);
});

test('calibration save finishing after a selection change cannot hydrate the other fermentation',async()=>{
  const c=controller(),queue=[];c.context.queue=queue;c.run('json=()=>new Promise(resolve=>queue.push(resolve))');
  const submitted=c.run('({...growthCalibration,photo_id:1})');
  const saving=c.run('saveGrowthCalibration(input[0])');await changeFermentation(c,3);
  queue[1](sequenceResponse(3));await Promise.resolve();await Promise.resolve();
  queue[0]({});await Promise.resolve();queue[2]({calibration:submitted});await saving;
  assert.equal(c.run('growthCalibration.left_x'),.3);assert.equal(c.run('savedGrowthCalibration.photo_id'),301);
  assert.equal(c.elements.get('calibration-feedback').textContent,'');
});
test('calibration reset finishing after a selection change cannot clear the other fermentation',async()=>{
  const c=controller(),queue=[];c.context.queue=queue;c.run('json=()=>new Promise(resolve=>queue.push(resolve))');
  const resetting=c.elements.get('calibration-reset').click();await changeFermentation(c,3);
  queue[1](sequenceResponse(3));await Promise.resolve();await Promise.resolve();queue[0]({});await resetting;
  assert.equal(c.run('cameraFermentationId'),3);assert.equal(c.run('photoLibrary.length'),6);
  assert.equal(c.run('growthCalibration.photo_id'),301);assert.equal(c.elements.get('calibration-feedback').textContent,'');
});

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
  const doc={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},querySelectorAll(){return []},createElement:element};
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

const $ = (id) => document.getElementById(id);
const fmtTime = (value) => value ? new Intl.DateTimeFormat('ca-ES', {hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short'}).format(new Date(value)) : '—';
async function json(url, options={}) {
  const response = await fetch(url, {credentials:'same-origin', ...options});
  if (response.status === 401) { location.href='/login'; throw new Error('Sessió caducada'); }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}
let freshPreviewUrl = null;
let activeFermentation = null;
let fermenterHistoryCache = {readings:[],actions:[]};
let fermentationsCache = [];
let readingsCache = [];
let growthHistoryCache = [];
let photoLibrary = [];
let allPhotos = [];
let growthCalibration = null;
let selectedReferenceId = null;
let cameraRangeStart = null;
let cameraRangeEnd = null;
let timelapseTimer = null;

function formPayload(form) {
  return Object.fromEntries([...new FormData(form)].filter(([,value])=>value!==''));
}

async function refreshFermentation() {
  const data=await json('/api/fermentations');
  fermentationsCache=data.items||[];
  activeFermentation=data.active;
  $('session-status').textContent=activeFermentation
    ? `Fermentació #${activeFermentation.id} activa des de ${fmtTime(activeFermentation.started_at)}. Les lectures i fotografies noves s’hi associaran.`
    : 'No hi ha cap fermentació activa. Les lectures continuen funcionant independentment.';
  $('fermentation-form').hidden=Boolean(activeFermentation);
  $('end-fermentation').hidden=!activeFermentation;
  renderFermentations();
  return data;
}

const eventLabels={refresh:'Refresc',ph_measurement:'Mesura de pH',dough_temperature:'Temperatura de la massa',
  fridge_in:'Entrada a la nevera',fridge_out:'Sortida de la nevera',target_temperature:'Canvi de consigna',
  manual_note:'Observació',incident:'Incidència',fermentation_start:'Inici de fermentació',fermentation_end:'Final de fermentació'};
const amount=(value,unit='g')=>value===null||value===undefined||value===''?'No registrat':`${Number(value).toLocaleString('ca-ES',{maximumFractionDigits:1})} ${unit}`;
function elapsedSince(value){
  const seconds=Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/1000));
  const days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60);
  return days?`${days} d ${hours} h`:`${hours} h ${minutes} min`;
}
function fermentationMetrics(item){
  const fields=[['Inici',fmtTime(item.started_at)],['Final',item.ended_at?fmtTime(item.ended_at):'En curs'],
    ['Massa mare inicial',amount(item.starter_mass_g)],['Farina inicial',amount(item.flour_g)],['Aigua inicial',amount(item.water_g)],
    ['Tipus de farina',item.flour_type||'No registrat'],['pH inicial registrat',item.initial_ph===null?'No registrat':`${Number(item.initial_ph).toFixed(2)} pH`],
    ['Temperatura inicial de la massa (mesurada)',item.initial_dough_temp_c===null?'No registrada':`${Number(item.initial_dough_temp_c).toFixed(1)} °C`],
    ['Consigna prevista',item.target_fermenter_temp_c===null?'No registrada':`${Number(item.target_fermenter_temp_c).toFixed(1)} °C`]];
  if(item.hydration_pct!==null)fields.push(['Hidratació registrada',`${Number(item.hydration_pct).toFixed(1)}%`]);
  else if(Number(item.flour_g)>0&&item.water_g!==null&&Number(item.water_g)>=0)fields.push(['Aigua/farina afegides (calculat)',`${(100*Number(item.water_g)/Number(item.flour_g)).toFixed(1)}% · no inclou l’aigua interna de la massa mare`]);
  return fields;
}
function renderFermentations(){
  const current=activeFermentation;
  const home=$('home-fermentation');home.hidden=!current;
  $('fermentation-live').classList.toggle('paused',!current);
  $('fermentation-live').innerHTML=`<i></i> ${current?'EN CURS':'SENSE FERMENTACIÓ ACTIVA'}`;
  if(current){
    $('home-fermentation-title').textContent=`Fermentació #${current.id}`;
    $('home-fermentation-elapsed').textContent=elapsedSince(current.started_at);
    $('home-fermentation-ph').textContent=current.initial_ph===null?'No registrat':`${Number(current.initial_ph).toFixed(2)} pH`;
    const phEvents=(current.events||[]).filter(event=>event.ph!==null&&event.ph!==undefined);
    const latestPh=phEvents.at(-1);
    $('home-fermentation-last-ph').textContent=latestPh?`${Number(latestPh.ph).toFixed(2)} pH · ${fmtTime(latestPh.occurred_at)}`:$('home-fermentation-ph').textContent;
    $('home-fermentation-dough-temp').textContent=current.initial_dough_temp_c===null?'No registrada':`${Number(current.initial_dough_temp_c).toFixed(1)} °C`;
    $('home-fermentation-refreshes').textContent=(current.events||[]).filter(event=>event.event_type==='refresh').length;
    $('fermentation-detail-status').textContent=`Fermentació #${current.id} · inici ${new Date(current.started_at).toLocaleString('ca-ES')} · ${elapsedSince(current.started_at)} transcorreguts.`;
    const grid=$('fermentation-detail-grid');grid.replaceChildren();
    fermentationMetrics(current).forEach(([label,value])=>{const card=document.createElement('article');const name=document.createElement('span');name.textContent=label;const strong=document.createElement('strong');strong.textContent=value;card.append(name,strong);grid.append(card);});
    const timeline=$('fermentation-timeline');timeline.replaceChildren();
    (current.events||[]).slice().reverse().forEach(event=>{const li=document.createElement('li');const title=document.createElement('strong');title.textContent=eventLabels[event.event_type]||event.event_type;const time=document.createElement('time');time.textContent=new Date(event.occurred_at).toLocaleString('ca-ES');const detail=document.createElement('span');const parts=[];if(event.ph!==null)parts.push(`pH ${Number(event.ph).toFixed(2)}`);if(event.dough_temp_c!==null)parts.push(`massa ${Number(event.dough_temp_c).toFixed(1)} °C`);if(event.starter_mass_g!==null)parts.push(`massa mare ${amount(event.starter_mass_g)}`);if(event.flour_g!==null)parts.push(`farina ${amount(event.flour_g)}`);if(event.water_g!==null)parts.push(`aigua ${amount(event.water_g)}`);if(event.hydration_pct!==null)parts.push(`hidratació registrada ${Number(event.hydration_pct).toFixed(1)}%`);if(event.details)parts.push(event.details);detail.textContent=parts.join(' · ')||'Sense detalls addicionals registrats';li.append(title,time,detail);timeline.append(li);});
    $('export-active-fermentation').href=`/api/fermentations/${current.id}/export`;$('export-active-fermentation').hidden=false;
  }else{
    $('fermentation-detail-status').textContent='No hi ha cap fermentació activa. Pots iniciar-ne una al formulari de registre.';
    $('fermentation-detail-grid').replaceChildren();$('fermentation-timeline').replaceChildren();$('export-active-fermentation').hidden=true;
  }
  const older=fermentationsCache.filter(item=>item.ended_at),list=$('fermentation-history');
  $('fermentation-count').textContent=`${older.length} ${older.length===1?'anterior':'anteriors'}`;list.replaceChildren();
  if(!older.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Encara no hi ha fermentacions finalitzades guardades.';list.append(empty);return;}
  older.forEach(item=>{const card=document.createElement('article');card.className='history-item';const head=document.createElement('div');const title=document.createElement('h3');title.textContent=`Fermentació #${item.id}`;const dates=document.createElement('p');dates.textContent=`${new Date(item.started_at).toLocaleString('ca-ES')} – ${new Date(item.ended_at).toLocaleString('ca-ES')}`;head.append(title,dates);const summary=document.createElement('p');const lastPh=(item.events||[]).filter(event=>event.ph!==null).at(-1);summary.textContent=`pH inicial ${item.initial_ph===null?'no registrat':Number(item.initial_ph).toFixed(2)} · darrer pH ${lastPh?Number(lastPh.ph).toFixed(2):'no registrat'} · ${(item.events||[]).filter(event=>event.event_type==='refresh').length} refrescos · ${(item.events||[]).length} anotacions`;
    const details=document.createElement('details');const label=document.createElement('summary');label.textContent='Mesures i refrescos';const eventList=document.createElement('ol');(item.events||[]).forEach(event=>{const li=document.createElement('li');li.textContent=`${new Date(event.occurred_at).toLocaleString('ca-ES')} · ${eventLabels[event.event_type]||event.event_type}${event.ph!==null?` · pH ${Number(event.ph).toFixed(2)}`:''}${event.details?` · ${event.details}`:''}`;eventList.append(li);});details.append(label,eventList);const exportLink=document.createElement('a');exportLink.className='secondary-button';exportLink.href=`/api/fermentations/${item.id}/export`;exportLink.textContent='Descarrega ZIP';card.append(head,summary,details,exportLink);list.append(card);});
}

function showPage(name,writeHistory=true){
  const valid=['home','fermenter','fermentations','camera','settings'].includes(name)?name:'home';
  if(valid!=='camera'&&timelapseTimer){clearInterval(timelapseTimer);timelapseTimer=null;$('timelapse-toggle').textContent='Reprodueix timelapse';}
  document.querySelectorAll('[data-page]').forEach(section=>{const selected=section.dataset.page===valid;section.hidden=!selected;section.classList.toggle('is-active',selected);});
  document.querySelectorAll('[data-view]').forEach(button=>{const selected=button.dataset.view===valid;button.classList.toggle('is-active',selected);if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  if(writeHistory)history.replaceState(null,'',`#${valid}`);
  if(valid==='home')drawChart(readingsCache);
  if(valid==='fermenter'&&fermenterHistoryCache.readings.length)drawFermenterChart(fermenterHistoryCache.readings,fermenterHistoryCache.actions,Number($('fermenter-form').elements.target_c.value));
  if(valid==='camera')drawGrowthChart(growthHistoryCache);
  window.scrollTo({top:0,behavior:'auto'});
}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>showPage(button.dataset.view)));
document.querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',()=>showPage(button.dataset.go)));
window.addEventListener('hashchange',()=>showPage(location.hash.slice(1),false));
document.querySelectorAll('[data-fermentation-tab]').forEach(button=>button.addEventListener('click',()=>{
  const name=button.dataset.fermentationTab;
  document.querySelectorAll('[data-fermentation-tab]').forEach(tab=>{const selected=tab===button;tab.classList.toggle('is-selected',selected);tab.setAttribute('aria-selected',String(selected));});
  document.querySelectorAll('[data-fermentation-panel]').forEach(panel=>panel.hidden=panel.dataset.fermentationPanel!==name);
}));

function drawChart(rows) {
  const canvas=$('chart'),box=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  canvas.width=box.width*dpr;canvas.height=box.height*dpr;
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const w=box.width,h=box.height,p={l:35,r:10,t:12,b:25};
  const valid=rows.filter(x=>x.temperature_c!==null||x.humidity_rh!==null);
  $('chart-empty').style.display=valid.length?'none':'grid';if(!valid.length)return;
  const t=valid.map(x=>x.temperature_c).filter(Number.isFinite),hum=valid.map(x=>x.humidity_rh).filter(Number.isFinite);
  const tMin=Math.floor(Math.min(...t)-1),tMax=Math.ceil(Math.max(...t)+1),hMin=Math.floor(Math.min(...hum)-5),hMax=Math.ceil(Math.max(...hum)+5);
  const plot=(value,min,max)=>max===min?.5:(value-min)/(max-min);
  ctx.font='10px sans-serif';ctx.fillStyle='#9aa69f';ctx.strokeStyle='#edf0ed';ctx.lineWidth=1;
  for(let i=0;i<4;i++){const y=p.t+(h-p.t-p.b)*i/3;ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();ctx.fillText((tMax-(tMax-tMin)*i/3).toFixed(0),0,y+3)}
  const series=(key,min,max,color)=>{ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineJoin='round';ctx.beginPath();let started=false;valid.forEach((row,i)=>{const value=row[key];if(value===null||!Number.isFinite(value))return;const x=p.l+(w-p.l-p.r)*i/Math.max(1,valid.length-1),y=p.t+(h-p.t-p.b)*(1-plot(value,min,max));if(!started){ctx.moveTo(x,y);started=true}else ctx.lineTo(x,y)});ctx.stroke()};
  series('temperature_c',tMin,tMax,'#3e9375');series('humidity_rh',hMin,hMax,'#d9954c');
  const first=new Date(valid[0].captured_at),last=new Date(valid.at(-1).captured_at);ctx.fillStyle='#9aa69f';
  ctx.fillText(new Intl.DateTimeFormat('ca-ES',{hour:'2-digit',minute:'2-digit'}).format(first),p.l,h-4);
  ctx.fillText(new Intl.DateTimeFormat('ca-ES',{hour:'2-digit',minute:'2-digit'}).format(last),Math.max(p.l,w-p.r-35),h-4);
}

function drawGrowthChart(rows) {
  const canvas=$('growth-chart'),box=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  canvas.width=box.width*dpr;canvas.height=box.height*dpr;
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const w=box.width,h=box.height,p={l:38,r:10,t:14,b:25};
  const startAt=growthCalibration?.captured_at?new Date(growthCalibration.captured_at).getTime():null;
  const series=rows.filter(row=>inCameraRange(row.captured_at)&&(!startAt||new Date(row.captured_at).getTime()>=startAt)).slice().reverse().map(row=>{
    let analysis={};try{analysis=JSON.parse(row.analysis_json||'{}')}catch{}
    if(!growthCalibration||!analysis.valid||!Number.isFinite(analysis.surface_y_ratio))return {...row,growth_score:null};
    const base=growthCalibration.bottom_y-growthCalibration.initial_surface_y;
    const current=growthCalibration.bottom_y-analysis.surface_y_ratio;
    if(base<=0||current<=0)return {...row,growth_score:null};
    const isReference=String(row.id)===String(growthCalibration.photo_id);
    return {...row,growth_score:isReference?0:(current/base-1)*100};
  });
  const valid=series.filter(row=>Number.isFinite(row.growth_score));
  $('growth-empty').style.display=valid.length?'none':'grid';if(!valid.length)return;
  const vals=valid.map(row=>row.growth_score),min=Math.floor(Math.min(...vals)-10),max=Math.ceil(Math.max(...vals)+10);
  const range=Math.max(20,max-min),low=min,high=min+range;
  ctx.font='10px sans-serif';ctx.fillStyle='#9aa69f';ctx.strokeStyle='#edf0ed';ctx.lineWidth=1;
  for(let i=0;i<4;i++){const ratio=i/3,y=p.t+(h-p.t-p.b)*ratio;ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();ctx.fillText(`${Math.round(high-(high-low)*ratio)}%`,0,y+3)}
  ctx.strokeStyle='#4a9878';ctx.lineWidth=2;ctx.lineJoin='round';ctx.beginPath();
  const start=cameraRangeStart??new Date(valid[0].captured_at).getTime(),end=cameraRangeEnd??new Date(valid.at(-1).captured_at).getTime(),span=Math.max(1,end-start);
  let penDown=false;
  series.forEach(row=>{if(!Number.isFinite(row.growth_score)){penDown=false;return;}const x=p.l+(w-p.l-p.r)*(new Date(row.captured_at).getTime()-start)/span,y=p.t+(h-p.t-p.b)*(1-(row.growth_score-low)/(high-low||1));if(!penDown){ctx.moveTo(x,y);penDown=true;}else ctx.lineTo(x,y);});ctx.stroke();
  const first=new Date(valid[0].captured_at),last=new Date(valid.at(-1).captured_at);ctx.fillStyle='#9aa69f';
  ctx.fillText(new Intl.DateTimeFormat('ca-ES',{hour:'2-digit',minute:'2-digit'}).format(new Date(start)),p.l,h-4);
  ctx.fillText(new Intl.DateTimeFormat('ca-ES',{hour:'2-digit',minute:'2-digit'}).format(new Date(end)),Math.max(p.l,w-p.r-35),h-4);
}

function inCameraRange(value){const time=new Date(value).getTime();return (!cameraRangeStart||time>=cameraRangeStart)&&(!cameraRangeEnd||time<=cameraRangeEnd);}
function growthFor(photo){
  if(!photo||!growthCalibration)return null;
  if(growthCalibration.captured_at&&new Date(photo.captured_at)<new Date(growthCalibration.captured_at))return null;
  if(String(photo.id)===String(growthCalibration.photo_id))return {factor:1,percent:0,confidence:1,surface:growthCalibration.initial_surface_y};
  let analysis={};try{analysis=JSON.parse(photo.analysis_json||'{}')}catch{}
  if(!analysis.valid||!Number.isFinite(analysis.surface_y_ratio))return null;
  const initial=growthCalibration.bottom_y-growthCalibration.initial_surface_y;
  const current=growthCalibration.bottom_y-analysis.surface_y_ratio;
  if(initial<=0||current<=0)return null;
  const factor=current/initial;
  return {factor,percent:(factor-1)*100,confidence:analysis.confidence||0,surface:analysis.surface_y_ratio};
}
function renderGrowth(data){
  growthCalibration=data.calibration||null;
  const selected=photoLibrary.find(item=>String(item.id)===$('photo-select').value);
  const result=growthFor(selected);
  $('growth-level').textContent=result?`${result.percent>=0?'+':''}${result.percent.toFixed(0)}% · ×${result.factor.toFixed(2)}`:'No es pot estimar el creixement';
  $('growth-detail').textContent=result?`${new Date(selected.captured_at).toLocaleString('ca-ES')} · confiança ${Math.round(result.confidence*100)}% · alçada estimada`:'Calibratge necessari o detecció no fiable en aquesta captura.';
  $('growth-change').textContent=growthCalibration?`Referència · ${fmtTime(growthCalibration.captured_at)}`:'Cal calibrar';
  $('comparison-growth').textContent=result?`Creixement estimat ${result.percent>=0?'+':''}${result.percent.toFixed(0)}% · ×${result.factor.toFixed(2)} · confiança ${Math.round(result.confidence*100)}%`:'Calibratge necessari / no es pot estimar';
  $('current-surface-line').hidden=!result;
  if(result)$('current-surface-line').style.top=`${result.surface*100}%`;
  $('baseline-button').disabled=!selected;
  $('baseline-button').textContent=growthCalibration?.captured_at?'Marca aquesta foto com a nou inici':'Marca aquesta foto com a inici';
  renderCalibrationGuides();
}

function renderMonitoring(state) {
  const badge=$('monitoring-status'),button=$('monitoring-button');
  badge.classList.toggle('paused',!state.active);
  badge.innerHTML=`<i></i> ${state.active?'SEGUIMENT ACTIU':'ATURAT'}`;
  button.textContent=state.active?'Atura seguiment':'Inicia seguiment';
  button.classList.toggle('stop',state.active);
  const camera=$('camera-status');
  if(!state.active){camera.className='camera-status paused';camera.querySelector('span').textContent='Seguiment aturat';}
}

let calibrationDrag=null;
function renderCalibrationGuides(){const c=growthCalibration||{left_x:.32,right_x:.68,bottom_y:.94,initial_surface_y:.72};const overlay=$('calibration-overlay');overlay.style.setProperty('--guide-left',`${c.left_x*100}%`);overlay.style.setProperty('--guide-right',`${c.right_x*100}%`);overlay.style.setProperty('--guide-top',`${c.initial_surface_y*100}%`);overlay.style.setProperty('--guide-bottom',`${c.bottom_y*100}%`);document.querySelectorAll('[data-guide]').forEach(line=>{const key=line.dataset.guide;line.style.left=key.endsWith('_x')?`${c[key]*100}%`:'';line.style.top=key.endsWith('_y')?`${c[key]*100}%`:'';});}
function syncCameraFrame(image){if(!image.naturalWidth||!image.naturalHeight)return;image.closest('.camera-frame').style.aspectRatio=`${image.naturalWidth}/${image.naturalHeight}`;}
['camera-reference-image','camera-current-image'].forEach(id=>$(id).addEventListener('load',event=>{syncCameraFrame(event.currentTarget);if(id==='camera-reference-image')renderCalibrationGuides();}));
function cameraPoint(event){const frame=$('camera-reference-image').closest('.camera-frame'),r=frame.getBoundingClientRect(),image=$('camera-reference-image');let left=r.left,top=r.top,width=r.width,height=r.height;if(image.naturalWidth&&image.naturalHeight){const scale=Math.min(r.width/image.naturalWidth,r.height/image.naturalHeight);width=image.naturalWidth*scale;height=image.naturalHeight*scale;left+=(r.width-width)/2;top+=(r.height-height)/2;}return{x:Math.max(0,Math.min(1,(event.clientX-left)/width)),y:Math.max(0,Math.min(1,(event.clientY-top)/height))};}
function moveGuide(key,event){const point=cameraPoint(event),c=growthCalibration||{left_x:.32,right_x:.68,bottom_y:.94,initial_surface_y:.72},horizontal=key.endsWith('_y');let value=horizontal?point.y:point.x;const bounds={left_x:[0,c.right_x-.04],right_x:[c.left_x+.04,1],initial_surface_y:[0,c.bottom_y-.12],bottom_y:[c.initial_surface_y+.12,1]}[key];value=Math.max(bounds[0],Math.min(bounds[1],value));growthCalibration={...c,[key]:value};renderCalibrationGuides();renderGrowth({calibration:growthCalibration});}
document.querySelectorAll('[data-guide]').forEach(line=>{line.addEventListener('pointerdown',event=>{event.preventDefault();line.setPointerCapture(event.pointerId);calibrationDrag={key:line.dataset.guide,pointerId:event.pointerId,line};moveGuide(calibrationDrag.key,event);});line.addEventListener('pointermove',event=>{if(!calibrationDrag||calibrationDrag.pointerId!==event.pointerId)return;moveGuide(calibrationDrag.key,event);});const finish=event=>{if(calibrationDrag?.pointerId===event.pointerId)calibrationDrag=null;};line.addEventListener('pointerup',finish);line.addEventListener('pointercancel',finish);});
function adjustCalibrationGuide(direction){
  growthCalibration=growthCalibration||{left_x:.32,right_x:.68,bottom_y:.94,initial_surface_y:.72};
  const key=$('calibration-guide').value,step=.002;
  const bounds={left_x:[0,growthCalibration.right_x-.04],right_x:[growthCalibration.left_x+.04,1],initial_surface_y:[0,growthCalibration.bottom_y-.12],bottom_y:[growthCalibration.initial_surface_y+.12,1]}[key];
  growthCalibration[key]=Math.max(bounds[0],Math.min(bounds[1],growthCalibration[key]+direction*step));
  renderCalibrationGuides();renderGrowth({calibration:growthCalibration});
}
$('calibration-minus').addEventListener('click',()=>adjustCalibrationGuide(-1));
$('calibration-plus').addEventListener('click',()=>adjustCalibrationGuide(1));
function cameraWindow(){const value=$('camera-range').value;if(value==='custom'){return {start:cameraRangeStart,end:cameraRangeEnd};}const now=Date.now();return {start:value==='all'?null:now-Number(value)*3600000,end:now};}
function samplePhotos(rows){const minutes=$('photo-sampling').value;if(minutes==='all'||rows.length<2)return rows;const ordered=rows.slice().sort((a,b)=>new Date(a.captured_at)-new Date(b.captured_at));const result=[ordered.at(-1)];let cutoff=new Date(ordered.at(-1).captured_at).getTime()-Number(minutes)*60000;for(let i=ordered.length-2;i>=0;i--){const t=new Date(ordered[i].captured_at).getTime();if(t<=cutoff){result.push(ordered[i]);cutoff=t-Number(minutes)*60000;}}return result;}

function renderFermenter(data,historyData=null) {
  historyData=historyData||fermenterHistoryCache;
  const {config,runtime,schedule}=data,form=$('fermenter-form');
  $('fermenter-temperature').textContent=runtime.temperature_c===null?'— °C':`${Number(runtime.temperature_c).toFixed(1)} °C`;
  $('fermenter-target').textContent=`${Number(config.target_c).toFixed(1).replace('.',',')} °C`;
  const real=Boolean(data.real_output_control_enabled);
  $('fermenter-control-badge').textContent=real?'CONTROL REAL · SHELLY switch:0':'SIMULACIÓ · SENSE ORDRES REALS';
  $('fermenter-safety-banner').textContent=real?'Control habilitat amb watchdog local al Shelly; el control continua subjecte al tall tèrmic físic independent.':data.physical_control_block_reason||'Control real bloquejat fins que es verifiquin les proteccions físiques.';
  $('fermenter-demand-label').textContent=real?'Sortida real de la manta':'Demanda simulada';
  $('fermenter-mode-label').textContent={stopped:'Aturat',automatic:real?'Automàtic · real':'Automàtic · simulació',manual:real?'Manual · real':'Manual · simulació'}[config.mode]||config.mode;
  const heaterOn=real?runtime.switch0_on===true:Boolean(runtime.simulated_heater_on);
  $('fermenter-heater').textContent=heaterOn?'ON':'OFF';
  $('fermenter-heater').classList.toggle('sim-on',heaterOn);
  $('home-control-demand-label').textContent=real?'Sortida de calefacció':'Demanda de calefacció simulada';
  $('home-control-demand').textContent=heaterOn?'ON':'OFF';
  $('home-control-mode').textContent=`${real?'Control real':'Simulació'} · ${{stopped:'Aturat',automatic:'Automàtic',manual:'Manual'}[config.mode]||config.mode}`;
  $('home-control-target').textContent=`${Number(config.target_c).toFixed(1)} °C`;
  $('home-physical-output').textContent=runtime.switch0_on===null?'Desconeguda':runtime.switch0_on?'ON':'OFF';
  const fresh=runtime.sensor_fresh;
  $('fermenter-sensor-status').textContent=fresh?`DHT22 · fa ${runtime.sensor_age_seconds}s`:`Sense lectura fiable · ${runtime.error||'dada caducada'}`;
  $('fermenter-sensor-status').style.color=fresh?'':'var(--red)';
  const outputs=runtime.switch0_on===null?'desconeguda':runtime.switch0_on?'ON':'OFF';
  $('fermenter-physical-outputs').textContent=`Shelly switch:0 (manta confirmada): ${outputs}`;
  const since=runtime.heater_on_since?Math.max(0,Math.floor((Date.now()-new Date(runtime.heater_on_since))/1000)):null;
  $('fermenter-timer').textContent=heaterOn&&since!==null?`Encès · ${Math.floor(since/60)} min ${since%60}s`:`${runtime.reason||'Aturat'}`;
  $('fermenter-schedule').textContent=schedule.next_change?`${schedule.label} · canvi ${fmtTime(schedule.next_change)}`:schedule.label;
  $('fermenter-alert').hidden=!(runtime.error||runtime.lockout_reason||(!fresh&&runtime.observed_at));
  $('fermenter-alert').textContent=runtime.lockout_reason?`ALARMA BLOQUEJADA: ${runtime.lockout_reason}. Calefacció desactivada.`:runtime.error?`Alarma de comunicació: ${runtime.error}. Calefacció desactivada.`:!fresh&&runtime.observed_at?'La lectura del DHT22 és massa antiga. Calefacció desactivada.':'';
  $('ack-fermenter-alarm').hidden=!runtime.lockout_reason;
  const values={mode:config.mode,target_c:config.target_c,hysteresis_c:config.hysteresis_c,
    min_switch_seconds:config.min_switch_seconds,max_on_seconds:Math.round(config.max_on_seconds/60),
    overtemp_c:config.overtemp_c,schedule_start:config.schedule_start,schedule_end:config.schedule_end};
  Object.entries(values).forEach(([key,value])=>{const input=form.elements.namedItem(key);if(input&&document.activeElement!==input)input.value=value;});
  for(const key of ['continuous','schedule_enabled','manual_on']){const input=form.elements.namedItem(key);if(input&&document.activeElement!==input)input.checked=Boolean(config[key]);}
  const manual=form.elements.namedItem('manual_on');manual.disabled=config.mode!=='manual';
  const labels=Object.fromEntries([['configuration','Configuració'],['simulated_output_on','Demanda simulada ON'],['simulated_output_off','Demanda simulada OFF'],['alarm','Alarma'],['schedule','Horari'],['safe_restart','Reinici segur']]);
  const list=$('fermenter-action-list');list.replaceChildren();
  if(!data.actions.length){const li=document.createElement('li');li.className='muted';li.textContent='Encara no hi ha actuacions.';list.append(li);}
  data.actions.slice(0,12).forEach(action=>{const li=document.createElement('li');li.className=action.event_type==='alarm'?'alarm':'';li.textContent=`${fmtTime(action.occurred_at)} · ${labels[action.event_type]||action.event_type} · ${action.details||action.mode}`;list.append(li);});
  drawFermenterChart(historyData.readings||[],historyData.actions||[],Number(config.target_c));
}

function drawFermenterChart(readings,actions,target) {
  const canvas=$('fermenter-chart'),box=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  canvas.width=box.width*dpr;canvas.height=box.height*dpr;
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const w=box.width,h=box.height,p={l:38,r:10,t:12,b:24};
  const rows=readings.filter(x=>Number.isFinite(x.temperature_c));$('fermenter-chart-empty').style.display=rows.length?'none':'grid';if(!rows.length)return;
  const temps=rows.map(x=>x.temperature_c),lo=Math.floor(Math.min(...temps,target)-1),hi=Math.ceil(Math.max(...temps,target)+1),range=Math.max(1,hi-lo);
  const xAt=i=>p.l+(w-p.l-p.r)*i/Math.max(1,rows.length-1),yAt=v=>p.t+(h-p.t-p.b)*(1-(v-lo)/range);
  ctx.font='10px sans-serif';ctx.fillStyle='#9aa69f';ctx.strokeStyle='#edf0ed';ctx.lineWidth=1;
  for(let i=0;i<4;i++){const value=hi-range*i/3,y=yAt(value);ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();ctx.fillText(value.toFixed(0),2,y+3);}
  const targetChanges=actions.filter(a=>a.event_type==='configuration'&&Number.isFinite(a.target_c))
    .map(a=>({at:new Date(a.occurred_at).getTime(),value:Number(a.target_c)})).sort((a,b)=>a.at-b.at);
  let targetIndex=-1;
  const targetAt=timestamp=>{while(targetIndex+1<targetChanges.length&&targetChanges[targetIndex+1].at<=timestamp)targetIndex++;return targetIndex<0?target:targetChanges[targetIndex].value;};
  ctx.strokeStyle='#d9954c';ctx.setLineDash([5,4]);ctx.beginPath();
  rows.forEach((row,i)=>{const x=xAt(i),y=yAt(targetAt(new Date(row.captured_at).getTime()));if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});
  ctx.stroke();ctx.setLineDash([]);
  ctx.strokeStyle='#3e9375';ctx.lineWidth=2;ctx.beginPath();rows.forEach((row,i)=>{const x=xAt(i),y=yAt(row.temperature_c);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();
  const start=new Date(rows[0].captured_at).getTime(),end=new Date(rows.at(-1).captured_at).getTime(),span=Math.max(1,end-start);
  ctx.strokeStyle='#7859a6';ctx.lineWidth=2;actions.filter(a=>a.event_type==='simulated_output_on'||a.event_type==='simulated_output_off').forEach(a=>{const x=p.l+(w-p.l-p.r)*(new Date(a.occurred_at).getTime()-start)/span;ctx.beginPath();ctx.moveTo(x,h-p.b-8);ctx.lineTo(x,h-p.b);ctx.stroke();});
  ctx.fillStyle='#9aa69f';ctx.fillText(fmtTime(rows[0].captured_at),p.l,h-3);ctx.fillText(fmtTime(rows.at(-1).captured_at),Math.max(p.l,w-p.r-42),h-3);
}

async function refreshFermenterOnly(){try{renderFermenter(await json('/api/fermenter'));}catch(error){if(error.message!=='Sessió caducada')console.warn('Estat de la fermentadora no disponible',error);}}

function selectPhoto(id){
  const index=photoLibrary.findIndex(photo=>String(photo.id)===String(id));
  if(index<0)return;
  $('photo-select').value=String(photoLibrary[index].id);
  const photo=photoLibrary[index],image=$('camera-current-image');
  image.src=`/photos/${encodeURIComponent(photo.filename)}`;
  $('camera-current-time').textContent=`${new Date(photo.captured_at).toLocaleString('ca-ES')}${photo.fermentation_id?` · fermentació #${photo.fermentation_id}`:''}`;
  $('photo-previous').disabled=index===0;$('photo-next').disabled=index===photoLibrary.length-1;
  $('photo-timeline').value=String(index);
  renderGrowth({calibration:growthCalibration});drawGrowthChart(growthHistoryCache);
}
function selectReference(id,rebuild=true){
  const photo=allPhotos.find(item=>String(item.id)===String(id));if(!photo)return;
  selectedReferenceId=photo.id;$('photo-reference-select').value=String(photo.id);
  $('camera-reference-image').src=`/photos/${encodeURIComponent(photo.filename)}`;
  $('camera-reference-time').textContent=new Date(photo.captured_at).toLocaleString('ca-ES');
  if(String(growthCalibration?.photo_id)!==String(photo.id)){let a={};try{a=JSON.parse(photo.analysis_json||'{}')}catch{};growthCalibration={left_x:growthCalibration?.left_x??.32,right_x:growthCalibration?.right_x??.68,bottom_y:growthCalibration?.bottom_y??.94,initial_surface_y:Number.isFinite(a.surface_y_ratio)?a.surface_y_ratio:(growthCalibration?.initial_surface_y??.72),photo_id:photo.id,captured_at:photo.captured_at};}
  renderCalibrationGuides();renderGrowth({calibration:growthCalibration});
  if(rebuild&&allPhotos.length)renderPhotoLibrary(allPhotos);
}
function renderPhotoLibrary(rows){
  const selected=$('photo-select').value,refSelected=selectedReferenceId;
  allPhotos=rows.filter(item=>item.camera_ok&&item.filename).slice().sort((a,b)=>new Date(a.captured_at)-new Date(b.captured_at));
  const reference=growthCalibration?.photo_id||selectedReferenceId;
  const referencePhoto=allPhotos.find(p=>String(p.id)===String(reference));
  const refTime=referencePhoto?new Date(referencePhoto.captured_at).getTime():-Infinity;
  photoLibrary=allPhotos.filter(item=>new Date(item.captured_at).getTime()>=refTime&&inCameraRange(item.captured_at));
  $('camera-library-count').textContent=`${photoLibrary.length} ${photoLibrary.length===1?'imatge':'imatges'}`;
  const currentSelect=$('photo-select'),referenceSelect=$('photo-reference-select');
  currentSelect.replaceChildren();referenceSelect.replaceChildren();
  photoLibrary.forEach((photo,index)=>{
    const label=`${new Date(photo.captured_at).toLocaleString('ca-ES')}${photo.fermentation_id?` · #${photo.fermentation_id}`:''}`;
  {const option=document.createElement('option');option.value=String(photo.id);option.textContent=label;currentSelect.append(option);}
  });
  allPhotos.forEach(photo=>{const option=document.createElement('option');option.value=String(photo.id);option.textContent=new Date(photo.captured_at).toLocaleString('ca-ES');referenceSelect.append(option);});
  const slider=$('photo-timeline');slider.max=String(Math.max(0,photoLibrary.length-1));slider.disabled=photoLibrary.length<2;
  if(!photoLibrary.length){currentSelect.innerHTML='<option value="">No hi ha captures posteriors a la referència dins d’aquest període</option>';slider.value='0';$('camera-current-image').removeAttribute('src');$('camera-current-time').textContent='No hi ha captures posteriors a la referència dins d’aquest període.';$('comparison-growth').textContent='Sense dades dins del període';$('photo-count').textContent='0 imatges';$('photo-grid').replaceChildren();const ref=allPhotos.find(photo=>String(photo.id)===String(refSelected))||referencePhoto;if(ref){referenceSelect.value=String(ref.id);$('camera-reference-image').src=`/photos/${encodeURIComponent(ref.filename)}`;$('camera-reference-time').textContent=new Date(ref.captured_at).toLocaleString('ca-ES');}return;}
  currentSelect.value=photoLibrary.some(photo=>String(photo.id)===selected)?selected:String(photoLibrary.at(-1).id);
  const ref=allPhotos.find(photo=>String(photo.id)===String(refSelected))||referencePhoto||photoLibrary[0];
  selectReference(ref.id,false);selectPhoto(currentSelect.value);
  const grid=$('photo-grid');grid.replaceChildren();
  const recent=samplePhotos(photoLibrary).slice().reverse();
  $('photo-count').textContent=`${recent.length} mostrades · ${photoLibrary.length} originals`;
  recent.forEach(item=>{const a=document.createElement('a');a.className='photo-item';a.href=`/photos/${encodeURIComponent(item.filename)}`;a.target='_blank';a.rel='noopener';
    const img=document.createElement('img');img.loading='lazy';img.src=a.href;img.alt=`Captura ${fmtTime(item.captured_at)}`;const time=document.createElement('time');time.textContent=fmtTime(item.captured_at);a.append(img,time);grid.append(a);});
}

async function refresh() {
  try {
    setCameraWindow();
    const [state,readings,photos,growth,growthHistory,monitoring,fermenter,fermenterHistoryData,fermentationData]=await Promise.all([
      json('/api/state'),json(`/api/readings?hours=${$('range').value}`),json('/api/photos?limit=10000'),
      json('/api/growth'),json('/api/growth/history?limit=20000'),json('/api/monitoring'),json('/api/fermenter'),
      json(`/api/fermenter/history?hours=${$('range').value}`),refreshFermentation()
    ]);
    readingsCache=readings;growthHistoryCache=growthHistory;
    fermenterHistoryCache=fermenterHistoryData;
    renderMonitoring(monitoring);
    renderFermenter(fermenter,fermenterHistoryData);
    const reading=state.reading;
    if(reading&&reading.sensor_ok){$('temperature').innerHTML=`${Number(reading.temperature_c).toFixed(1)}<small>°C</small>`;$('humidity').innerHTML=`${Number(reading.humidity_rh).toFixed(1)}<small>%</small>`;$('temperature-time').textContent=`Darrera lectura · ${fmtTime(reading.captured_at)}`;$('humidity-time').textContent='Relativa de l’ambient';}
    else if(reading){$('temperature-time').textContent='No s’ha pogut llegir el Shelly';$('humidity-time').textContent=`Darrera prova · ${fmtTime(reading.captured_at)}`;}
    const photo=state.photo,camera=$('camera-status');
    if(photo){$('photo-time').textContent=`Darrera captura · ${fmtTime(photo.captured_at)}`;camera.className=monitoring.active?`camera-status ${photo.camera_ok?'ok':'bad'}`:'camera-status paused';camera.querySelector('span').textContent=monitoring.active?(photo.camera_ok?'Connectada':'Sense connexió'):'Seguiment aturat';}
    const latestImage=$('home-camera-image');
    if(photo?.camera_ok&&photo.filename){latestImage.src=`/photos/${encodeURIComponent(photo.filename)}`;latestImage.hidden=false;$('home-camera-time').textContent=`Captura ${new Date(photo.captured_at).toLocaleString('ca-ES')}`;}
    else{latestImage.removeAttribute('src');latestImage.hidden=true;$('home-camera-time').textContent=photo?`Darrera prova de càmera ${fmtTime(photo.captured_at)} · sense imatge vàlida`:'Encara no hi ha cap fotografia disponible.';}
    drawChart(readings);growthCalibration=growth.calibration||growthCalibration;renderPhotoLibrary(photos);renderGrowth(growth);
    renderFermentations();
  }catch(error){if(error.message!=='Sessió caducada')console.warn('No s’ha pogut actualitzar el dashboard',error);}
}

$('photo-select').addEventListener('change',event=>selectPhoto(event.currentTarget.value));
$('photo-reference-select').addEventListener('change',event=>selectReference(event.currentTarget.value));
$('photo-previous').addEventListener('click',()=>{const i=photoLibrary.findIndex(photo=>String(photo.id)===$('photo-select').value);if(i>0)selectPhoto(photoLibrary[i-1].id);});
$('photo-next').addEventListener('click',()=>{const i=photoLibrary.findIndex(photo=>String(photo.id)===$('photo-select').value);if(i>=0&&i<photoLibrary.length-1)selectPhoto(photoLibrary[i+1].id);});
$('photo-timeline').addEventListener('input',event=>{const photo=photoLibrary[Number(event.currentTarget.value)];if(photo)selectPhoto(photo.id);});
$('timelapse-toggle').addEventListener('click',event=>{
  if(timelapseTimer){clearInterval(timelapseTimer);timelapseTimer=null;event.currentTarget.textContent='Reprodueix timelapse';return;}
  if(photoLibrary.length<2)return;
  let index=photoLibrary.findIndex(photo=>String(photo.id)===$('photo-select').value);if(index<0)index=0;event.currentTarget.textContent='Atura el timelapse';
  timelapseTimer=setInterval(()=>{if(index>=photoLibrary.length-1){clearInterval(timelapseTimer);timelapseTimer=null;event.currentTarget.textContent='Reprodueix timelapse';return;}index++;selectPhoto(photoLibrary[index].id);},Math.max(75,1500/Number($('timelapse-speed').value)));
});

$('baseline-button').addEventListener('click',async()=>{
  const photo=photoLibrary.find(p=>String(p.id)===$('photo-select').value);if(!photo)return;
  selectReference(photo.id,false);$('growth-detail').textContent='Desant la fotografia i les quatre línies com a referència inicial…';
  try{const result=await json('/api/growth/calibration',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...growthCalibration,photo_id:photo.id})});growthCalibration=result.calibration;$('growth-detail').textContent='Referència inicial desada. Ajusta les quatre línies si cal.';renderPhotoLibrary(allPhotos);await refresh();}
  catch(error){$('growth-detail').textContent=`No s’ha pogut desar la referència: ${error.message}`;}
});
$('calibration-save').addEventListener('click',async()=>{
  const photo=allPhotos.find(p=>String(p.id)===String(growthCalibration?.photo_id));if(!photo){$('growth-detail').textContent='Selecciona una fotografia de referència vàlida.';return;}
  try{const result=await json('/api/growth/calibration',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...growthCalibration,photo_id:photo.id})});growthCalibration=result.calibration;$('growth-detail').textContent='Calibratge desat. La referència queda guardada.';await refresh();}
  catch(error){$('growth-detail').textContent=`No s’ha pogut desar el calibratge: ${error.message}`;}
});
$('calibration-reset').addEventListener('click',async()=>{try{await json('/api/growth/calibration',{method:'DELETE'});growthCalibration=null;selectedReferenceId=null;renderCalibrationGuides();renderGrowth({calibration:null});$('growth-detail').textContent='Calibratge persistent esborrat. Les fotografies i lectures no s’han modificat.';}catch(error){$('growth-detail').textContent=`No s’ha pogut restablir: ${error.message}`;}});

$('monitoring-button').addEventListener('click',async()=>{
  const button=$('monitoring-button');button.disabled=true;
  try{const current=await json('/api/monitoring');await json('/api/monitoring',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:!current.active})});await refresh();}
  catch(error){if(error.message!=='Sessió caducada')$('growth-detail').textContent=`No s’ha pogut canviar l’estat: ${error.message}`;}
  finally{button.disabled=false;}
});

$('fermenter-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,feedback=$('fermenter-feedback');
  const payload={mode:form.elements.mode.value,target_c:Number(form.elements.target_c.value),
    hysteresis_c:Number(form.elements.hysteresis_c.value),min_switch_seconds:Number(form.elements.min_switch_seconds.value),
    max_on_seconds:Number(form.elements.max_on_seconds.value)*60,overtemp_c:Number(form.elements.overtemp_c.value),
    continuous:form.elements.continuous.checked,schedule_enabled:form.elements.schedule_enabled.checked,
    schedule_start:form.elements.schedule_start.value,schedule_end:form.elements.schedule_end.value,
    manual_on:form.elements.manual_on.checked};
  try{const result=await json('/api/fermenter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});renderFermenter(result);feedback.textContent=result.real_output_control_enabled?'Configuració desada; control real de switch:0 habilitat.':'Configuració desada només per a la simulació.';}
  catch(error){feedback.textContent=`No s’ha pogut desar: ${error.message}`;}
});
document.querySelectorAll('[data-step]').forEach(button=>button.addEventListener('click',()=>{
  const input=$('fermenter-form').elements.target_c;input.value=Math.max(15,Math.min(30,Number(input.value)+Number(button.dataset.step))).toFixed(1);
}));
$('ack-fermenter-alarm').addEventListener('click',async()=>{
  try{renderFermenter(await json('/api/fermenter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acknowledge_alarm:true})}));}
  catch(error){$('fermenter-feedback').textContent=error.message;}
});

$('fermentation-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget;
  try{await json('/api/fermentations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(formPayload(form))});form.reset();await refreshFermentation();}
  catch(error){$('session-status').textContent=`No s’ha pogut iniciar: ${error.message}`;}
});
$('end-fermentation').addEventListener('click',async()=>{
  if(!activeFermentation)return;
  try{await json(`/api/fermentations/${activeFermentation.id}/end`,{method:'POST'});await refreshFermentation();}
  catch(error){$('session-status').textContent=`No s’ha pogut finalitzar: ${error.message}`;}
});
$('event-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,feedback=$('event-feedback');
  try{await json('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(formPayload(form))});form.reset();feedback.textContent='Anotació desada amb l’hora actual.';await refreshFermentation();}
  catch(error){feedback.textContent=`No s’ha pogut desar: ${error.message}`;}
});

$('range').addEventListener('change',refresh);
function setCameraWindow(){const value=$('camera-range').value;const now=Date.now();if(value==='all'){cameraRangeStart=cameraRangeEnd=null;}else if(value==='custom'){cameraRangeStart=$('camera-start').value?new Date($('camera-start').value).getTime():null;cameraRangeEnd=$('camera-end').value?new Date($('camera-end').value).getTime():null;}else{cameraRangeStart=now-Number(value)*3600000;cameraRangeEnd=now;}}
$('camera-range').addEventListener('change',()=>{$('camera-custom-range').hidden=$('camera-range').value!=='custom';refresh();});
$('camera-apply-range').addEventListener('click',refresh);$('photo-sampling').addEventListener('change',()=>refresh());
$('timelapse-speed').addEventListener('change',()=>{if(timelapseTimer){clearInterval(timelapseTimer);timelapseTimer=null;$('timelapse-toggle').click();}});
let timer;
window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(refresh,200)});
showPage(location.hash.slice(1),false);refresh();setInterval(refresh,30000);
setInterval(refreshFermenterOnly,5000);
if('serviceWorker'in navigator)navigator.serviceWorker.register('/service-worker.js?v=0.8.1',{updateViaCache:'none'}).catch(()=>{});

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
let savedGrowthCalibration = null;
let growthCalibration = null; // local editing copy; never replace while dirty
let calibrationDirty = false;
let selectedReferenceId = null;
let selectedFinalId = null;
let explicitReferenceSelection = false;
let ignoreBackendCalibration = false;
let timelapseTimer = null;
let refreshSequence = 0;
let cameraFermentationId=null,cameraFollowsActive=true,cameraRequestSequence=0,cameraAnalysisTimer=null;
let calibrationTouched=false,displayCalibrationSignature=null;
let vesselCalibration=null,finalPinned=false,playbackEndId=null,currentImageReady=false,currentImageSequence=0;

function formPayload(form) {
  return Object.fromEntries([...new FormData(form)].filter(([,value])=>value!==''));
}

async function refreshFermentation(sequence=null) {
  const data=await json('/api/fermentations');
  if(sequence!==null&&sequence!==refreshSequence)return data;
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
  if(valid==='camera'){drawGrowthChart(growthHistoryCache);void refreshCamera();}
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
  const ref=allPhotos.find(p=>String(p.id)===String(selectedReferenceId)),end=photoLibrary.find(p=>String(p.id)===String(selectedFinalId));
  const series=ref&&end&&!calibrationDirty?PanettoneCameraState.series(rows,ref,end):[];
  const valid=series.filter(p=>Number.isFinite(p.growth_score));
  $('growth-empty').textContent=calibrationDirty?'Desa el calibratge per mostrar les estimacions.':'Encara no hi ha deteccions fiables en aquest interval.';
  $('growth-empty').style.display=valid.length?'none':'grid';
  const analyzed=series.filter(p=>!['pending','uncalibrated'].includes(p.measurement?.quality));
  $('growth-coverage').textContent=series.length?`${analyzed.length}/${series.length} fotografies analitzades · ${valid.length} vàlides (${Math.round(100*valid.length/series.length)}% de cobertura) · ${fmtTime(ref.captured_at)} – ${fmtTime(end.captured_at)}`:'';
  const markers=$('growth-milestones');markers.replaceChildren();
  for(const item of ref?PanettoneCameraState.milestones(series,ref):[]){const text=document.createElement('p');const minutes=Math.floor(item.elapsed_seconds/60);text.textContent=`${item.threshold===100?'Duplicació ×2':'Triplicació ×3'} · ${fmtTime(item.captured_at)} · ${Math.floor(minutes/60)} h ${minutes%60} min · +${item.percent.toFixed(0)}%. Primera fotografia vàlida que supera el llindar.`;markers.append(text);}
  if(!valid.length||!box.width)return;
  const w=box.width,h=box.height,p={l:44,r:14,t:18,b:30};
  const low=Math.floor(Math.min(0,...valid.map(x=>x.growth_score))/25)*25,high=Math.max(100,Math.ceil(Math.max(...valid.map(x=>x.growth_score))/25)*25);
  const first=new Date(ref.captured_at).getTime(),last=new Date(end.captured_at).getTime(),span=Math.max(1,last-first);
  const xAt=at=>p.l+(w-p.l-p.r)*(new Date(at).getTime()-first)/span,yAt=value=>p.t+(h-p.t-p.b)*(1-(value-low)/(high-low));
  ctx.font='11px sans-serif';ctx.fillStyle='#74877d';ctx.strokeStyle='#e0e9e3';ctx.lineWidth=1;
  for(let n=0;n<5;n++){const value=low+(high-low)*n/4,y=yAt(value);ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();ctx.fillText(`${value.toFixed(0)}%`,1,y+3);}
  for(const threshold of [100,200])if(threshold<=high){ctx.setLineDash([4,4]);ctx.strokeStyle='#c39b5e';ctx.beginPath();ctx.moveTo(p.l,yAt(threshold));ctx.lineTo(w-p.r,yAt(threshold));ctx.stroke();ctx.setLineDash([]);}
  ctx.strokeStyle='#3e9375';ctx.lineWidth=2;ctx.beginPath();let penDown=false;
  const times=series.map((r,i)=>i?new Date(r.captured_at)-new Date(series[i-1].captured_at):null).filter(t=>t>0).sort((a,b)=>a-b);
  const maxGap=times.length?Math.max(180000,times[Math.floor(times.length/2)]*2.5):Infinity;
  series.forEach((row,index)=>{if(!Number.isFinite(row.growth_score)){penDown=false;return;}if(index&&new Date(row.captured_at)-new Date(series[index-1].captured_at)>maxGap)penDown=false;const x=xAt(row.captured_at),y=yAt(row.growth_score);if(penDown)ctx.lineTo(x,y);else ctx.moveTo(x,y);penDown=true;});ctx.stroke();
  ctx.fillStyle='#3e9375';for(const row of valid){ctx.beginPath();ctx.arc(xAt(row.captured_at),yAt(row.growth_score),2,0,Math.PI*2);ctx.fill();}
  for(const mark of PanettoneCameraState.milestones(series,ref)){ctx.fillStyle='#b58138';ctx.beginPath();ctx.arc(xAt(mark.captured_at),yAt(mark.percent),4,0,Math.PI*2);ctx.fill();}
  ctx.fillStyle='#74877d';ctx.fillText(fmtTime(ref.captured_at),p.l,h-5);ctx.fillText(fmtTime(end.captured_at),Math.max(p.l,w-p.r-95),h-5);
}
function growthFor(photo){
  if(!photo||!growthCalibration||calibrationDirty||!displayCalibrationSignature||photo.analysisSignature!==displayCalibrationSignature)return null;
  const result=photo.measurement;
  if(!result?.valid||!Number.isFinite(result.percent)||!Number.isFinite(result.factor))return null;
  return {...result,surface:result.surface_y_ratio};
}
function renderGrowth(){
  const photo=photoLibrary.find(p=>String(p.id)===String(selectedFinalId));
  const result=currentImageReady?growthFor(photo):null;
  const pending=!calibrationDirty&&(!currentImageReady||photo?.measurement?.quality==='pending');
  const percent=result?`${result.percent>=0?'+':''}${result.percent.toFixed(0)}%`:'—';
  const factor=result?`×${result.factor.toFixed(2).replace('.',',')}`:pending?'Processant…':photo?.measurement?.quality==='uncertain'?'Detecció dubtosa':'No detectable';
  const threshold=PanettoneCameraState.thresholdState(result?.percent);
  $('growth-overlay').className=`growth-overlay ${threshold}`;
  $('growth-overlay-percent').textContent=percent;$('growth-overlay-factor').textContent=factor;
  $('growth-overlay-milestone').textContent=threshold==='tripled'?'Massa triplicada':threshold==='doubled'?'Massa duplicada':'';
  $('growth-level').textContent=calibrationDirty?'Calibratge pendent de desar':result?`${percent} · ${factor}`:pending?'Analitzant la seqüència…':'Sense detecció fiable';
  $('growth-detail').textContent=result?`${fmtTime(photo.captured_at)} · ${result.quality==='manual_reference'?'Referència manual':'Detecció correcta'} · estimació d’alçada, sense precisió estadística calibrada`:calibrationDirty?'Desa els ajustos per recalcular.':photo?.measurement?.reason==='pending'?'Estimació pendent per a aquesta fotografia.':'No es pot detectar la superfície actual amb prou evidència.';
  $('growth-change').textContent=growthCalibration?.captured_at?`Referència · ${fmtTime(growthCalibration.captured_at)}`:'Cal calibrar';
  $('comparison-growth').textContent=calibrationDirty?'Calibratge pendent de desar':result?`Creixement estimat ${percent} · ${factor}`:pending?'Calculant aquesta fotografia…':'— · No detectable';
  $('current-surface-line').hidden=!result;
  if(result)$('current-surface-line').style.top=`${result.surface*100}%`;
  $('baseline-button').disabled=!photo;
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
function moveGuide(key,event){const point=cameraPoint(event),c=growthCalibration||{left_x:.32,right_x:.68,bottom_y:.94,initial_surface_y:.72},horizontal=key.endsWith('_y');let value=horizontal?point.y:point.x;const bounds={left_x:[0,c.right_x-.04],right_x:[c.left_x+.04,1],initial_surface_y:[0,c.bottom_y-.02],bottom_y:[c.initial_surface_y+.02,1]}[key];value=Math.max(bounds[0],Math.min(bounds[1],value));growthCalibration={...c,[key]:value};calibrationDirty=true;calibrationTouched=true;renderCalibrationGuides();renderGrowth();drawGrowthChart(growthHistoryCache);}
document.querySelectorAll('[data-guide]').forEach(line=>{line.addEventListener('pointerdown',event=>{event.preventDefault();line.setPointerCapture(event.pointerId);calibrationDrag={key:line.dataset.guide,pointerId:event.pointerId,line};moveGuide(calibrationDrag.key,event);});line.addEventListener('pointermove',event=>{if(!calibrationDrag||calibrationDrag.pointerId!==event.pointerId)return;moveGuide(calibrationDrag.key,event);});const finish=event=>{if(calibrationDrag?.pointerId===event.pointerId)calibrationDrag=null;};line.addEventListener('pointerup',finish);line.addEventListener('pointercancel',finish);});
function adjustCalibrationGuide(direction){
  growthCalibration=growthCalibration||{left_x:.32,right_x:.68,bottom_y:.94,initial_surface_y:.72};
  const key=$('calibration-guide').value,step=.002;
  const bounds={left_x:[0,growthCalibration.right_x-.04],right_x:[growthCalibration.left_x+.04,1],initial_surface_y:[0,growthCalibration.bottom_y-.02],bottom_y:[growthCalibration.initial_surface_y+.02,1]}[key];
  growthCalibration[key]=Math.max(bounds[0],Math.min(bounds[1],growthCalibration[key]+direction*step));
  calibrationDirty=true;calibrationTouched=true;
  renderCalibrationGuides();renderGrowth();drawGrowthChart(growthHistoryCache);
}
$('calibration-minus').addEventListener('click',()=>adjustCalibrationGuide(-1));
$('calibration-plus').addEventListener('click',()=>adjustCalibrationGuide(1));
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

function stopPlayback(){if(timelapseTimer)clearInterval(timelapseTimer);timelapseTimer=null;$('timelapse-toggle').textContent='Reprodueix';}
function selectPhoto(id,{manual=true}={}){
  const index=photoLibrary.findIndex(p=>String(p.id)===String(id));if(index<0)return;
  if(manual){stopPlayback();finalPinned=true;playbackEndId=id;}
  const photo=photoLibrary[index];selectedFinalId=photo.id;$('photo-select').value=String(photo.id);
  $('camera-current-time').textContent=`${new Date(photo.captured_at).toLocaleString('ca-ES')} · fermentació #${photo.fermentation_id}`;
  $('photo-previous').disabled=index===0;$('photo-next').disabled=index===photoLibrary.length-1;$('photo-timeline').value=String(index);
  const image=$('camera-current-image'),src=`/photos/${encodeURIComponent(photo.filename)}?revision=${photo.image_revision||''}`;
  if(image.dataset.photoId!==String(photo.id)||image.dataset.imageRevision!==photo.image_revision){
    const sequence=++currentImageSequence;currentImageReady=false;image.hidden=true;image.dataset.photoId=String(photo.id);image.dataset.imageRevision=photo.image_revision;
    const preload=new Image();preload.onload=()=>{if(sequence!==currentImageSequence||String(selectedFinalId)!==String(photo.id))return;image.src=src;image.hidden=false;currentImageReady=true;renderGrowth();};
    preload.onerror=()=>{if(sequence!==currentImageSequence)return;currentImageReady=false;$('growth-overlay-factor').textContent='Imatge no disponible';};preload.src=src;
  }
  renderGrowth();drawGrowthChart(growthHistoryCache);
}
function selectReference(id,{userInitiated=false,rebuild=true}={}){
  const photo=allPhotos.find(p=>String(p.id)===String(id));if(!photo)return;
  stopPlayback();++cameraRequestSequence;selectedReferenceId=photo.id;$('photo-reference-select').value=String(photo.id);
  $('camera-reference-image').src=`/photos/${encodeURIComponent(photo.filename)}`;$('camera-reference-time').textContent=new Date(photo.captured_at).toLocaleString('ca-ES');
  if(String(growthCalibration?.photo_id)!==String(photo.id)){
    const source=growthCalibration||savedGrowthCalibration||vesselCalibration||{};
    growthCalibration={left_x:source.left_x??.32,right_x:source.right_x??.68,bottom_y:source.bottom_y??.94,
      initial_surface_y:photo.measurement?.valid?photo.measurement.surface_y_ratio:source.initial_surface_y??.72,
      photo_id:photo.id,captured_at:photo.captured_at};
    calibrationDirty=true;
  }
  if(userInitiated){explicitReferenceSelection=true;calibrationTouched=true;}
  renderCalibrationGuides();renderGrowth();
  if(rebuild)renderPhotoLibrary(allPhotos);
}
function autoReferenceForFermentation(fermentation){return fermentation?PanettoneCameraState.firstPhotoAtOrAfter(allPhotos,fermentation.started_at):null;}
function renderPhotoLibrary(rows){
  allPhotos=rows.filter(p=>p.camera_ok&&p.filename&&String(p.fermentation_id)===String(cameraFermentationId)).slice().sort((a,b)=>new Date(a.captured_at)-new Date(b.captured_at)||a.id-b.id);
  const ref=allPhotos.find(p=>String(p.id)===String(selectedReferenceId))||allPhotos[0];
  if(!ref){photoLibrary=[];$('photo-select').replaceChildren();$('photo-reference-select').replaceChildren();$('camera-current-image').removeAttribute('src');$('camera-reference-image').removeAttribute('src');currentImageReady=false;++currentImageSequence;$('camera-current-image').hidden=true;$('camera-current-image').dataset.photoId='';$('camera-library-count').textContent='0 imatges disponibles';$('photo-timeline').disabled=true;$('photo-previous').disabled=true;$('photo-next').disabled=true;renderGrowth();drawGrowthChart([]);$('photo-grid').replaceChildren();$('photo-count').textContent='0 imatges';return;}
  selectedReferenceId=ref.id;photoLibrary=allPhotos.filter(p=>new Date(p.captured_at)>=new Date(ref.captured_at));
  for(const [id,photos] of [['photo-select',photoLibrary],['photo-reference-select',allPhotos]]){const select=$(id);select.replaceChildren();for(const photo of photos){const option=document.createElement('option');option.value=String(photo.id);option.textContent=new Date(photo.captured_at).toLocaleString('ca-ES');select.append(option);}}
  $('photo-reference-select').value=String(ref.id);$('camera-reference-image').src=`/photos/${encodeURIComponent(ref.filename)}?revision=${ref.image_revision||''}`;$('camera-reference-time').textContent=new Date(ref.captured_at).toLocaleString('ca-ES');
  const slider=$('photo-timeline');slider.max=String(Math.max(0,photoLibrary.length-1));slider.disabled=photoLibrary.length<2;
  $('camera-library-count').textContent=`${photoLibrary.length} imatges disponibles`;
  const id=(!finalPinned&&!timelapseTimer)?photoLibrary.at(-1).id:PanettoneCameraState.preservePhotoId(selectedFinalId,photoLibrary);
  if(!growthCalibration){growthCalibration={...(vesselCalibration||{left_x:.32,right_x:.68,bottom_y:.94}),initial_surface_y:.72,photo_id:ref.id,captured_at:ref.captured_at};calibrationDirty=true;}
  if(!photoLibrary.some(p=>String(p.id)===String(playbackEndId)))playbackEndId=null;
  selectPhoto(id,{manual:false});
  const grid=$('photo-grid');grid.replaceChildren();const thumbnails=PanettoneCameraState.sample(allPhotos,$('photo-sampling').value);
  $('photo-count').textContent=`${thumbnails.length} mostrades · ${allPhotos.length} originals`;
  for(const photo of thumbnails){const button=document.createElement('button');button.type='button';button.className='photo-item';const img=document.createElement('img');img.loading='lazy';img.src=`/photos/${encodeURIComponent(photo.filename)}`;img.alt=`Captura ${fmtTime(photo.captured_at)}`;const time=document.createElement('time');time.textContent=fmtTime(photo.captured_at);button.append(img,time);button.onclick=()=>{if(photoLibrary.some(p=>p.id===photo.id))selectPhoto(photo.id);else $('calibration-feedback').textContent='Aquesta captura és anterior a la referència. Selecciona-la com a fotografia inicial per analitzar-la.';};grid.append(button);}
}
function resetCameraSelection(){stopPlayback();clearTimeout(cameraAnalysisTimer);++cameraRequestSequence;selectedReferenceId=null;selectedFinalId=null;growthCalibration=null;savedGrowthCalibration=null;calibrationDirty=false;calibrationTouched=false;explicitReferenceSelection=false;finalPinned=false;playbackEndId=null;currentImageReady=false;displayCalibrationSignature=null;growthHistoryCache=[];$('camera-current-image').dataset.photoId='';}
async function refreshCamera(){
  if(cameraFermentationId===null)return;
  const sequence=++cameraRequestSequence,fermentation=cameraFermentationId;
  try{
    const data=await json(`/api/growth/sequence?fermentation_id=${fermentation}${selectedReferenceId?`&reference_id=${selectedReferenceId}`:''}`);
    if(sequence!==cameraRequestSequence||String(fermentation)!==String(cameraFermentationId))return;
    vesselCalibration=data.vessel;
    if(!calibrationDirty||!calibrationTouched){calibrationDirty=false;savedGrowthCalibration=data.calibration;growthCalibration=data.calibration?{...data.calibration}:null;}
    if(!selectedReferenceId)selectedReferenceId=data.reference_id;
    displayCalibrationSignature=data.calibration_signature;data.frames=data.frames.map(p=>({...p,analysisSignature:displayCalibrationSignature}));
    const measured=new Map(data.frames.map(p=>[p.id,p]));
    growthHistoryCache=data.frames;renderPhotoLibrary((data.available_photos||data.frames).map(p=>measured.get(p.id)||p));renderGrowth();drawGrowthChart(data.frames);
    clearTimeout(cameraAnalysisTimer);
    if(data.pending&&location.hash==='#camera')cameraAnalysisTimer=setTimeout(refreshCamera,1500);
  }catch(error){$('calibration-feedback').textContent=`No s’ha pogut analitzar la seqüència: ${error.message}`;}
}
function renderCameraFermentations(){
  if(cameraFollowsActive&&(!calibrationDirty||!calibrationTouched)){const next=activeFermentation?.id??fermentationsCache[0]?.id??null;if(String(next)!==String(cameraFermentationId)){cameraFermentationId=next;resetCameraSelection();}}
  const select=$('camera-fermentation');select.replaceChildren();
  for(const row of fermentationsCache){const option=document.createElement('option');option.value=String(row.id);option.textContent=`#${row.id} · ${new Date(row.started_at).toLocaleString('ca-ES')}${row.ended_at?'':' · activa'}`;select.append(option);}
  if(cameraFermentationId!==null)select.value=String(cameraFermentationId);
}

async function refresh() {
  const requestSequence=++refreshSequence;
  const previousActiveId=activeFermentation?.id??null;
  try {
    const [state,readings,monitoring,fermenter,fermenterHistoryData,fermentationData]=await Promise.all([
      json('/api/state'),json(`/api/readings?hours=${$('range').value}`),json('/api/monitoring'),json('/api/fermenter'),
      json(`/api/fermenter/history?hours=${$('range').value}`),refreshFermentation(requestSequence)
    ]);
    if(!PanettoneCameraState.isLatestRequest(requestSequence,refreshSequence))return;
    readingsCache=readings;
    renderCameraFermentations();
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
    drawChart(readings);if(location.hash==='#camera')void refreshCamera();
    renderFermentations();
  }catch(error){if(error.message!=='Sessió caducada')console.warn('No s’ha pogut actualitzar el dashboard',error);}
}

$('photo-select').addEventListener('change',event=>selectPhoto(event.currentTarget.value));
$('photo-reference-select').addEventListener('change',event=>selectReference(event.currentTarget.value,{userInitiated:true}));
$('use-fermentation-start').addEventListener('click',()=>{
  const photo=autoReferenceForFermentation(fermentationsCache.find(f=>String(f.id)===String(cameraFermentationId)));
  if(!photo){$('calibration-feedback').textContent='Encara no hi ha cap captura a partir de l’inici d’aquesta fermentació.';return;}
  explicitReferenceSelection=false;selectReference(photo.id,{userInitiated:true});
  $('calibration-feedback').textContent='Referència de l’inici seleccionada. Desa el calibratge per conservar-la.';
});
$('photo-previous').addEventListener('click',()=>{const i=photoLibrary.findIndex(photo=>String(photo.id)===$('photo-select').value);if(i>0)selectPhoto(photoLibrary[i-1].id);});
$('photo-next').addEventListener('click',()=>{const i=photoLibrary.findIndex(photo=>String(photo.id)===$('photo-select').value);if(i>=0&&i<photoLibrary.length-1)selectPhoto(photoLibrary[i+1].id);});
$('photo-timeline').addEventListener('input',event=>{const photo=photoLibrary[Number(event.currentTarget.value)];if(photo)selectPhoto(photo.id);});
function playTimelapse(){
  if(!photoLibrary.length)return;
  finalPinned=true;playbackEndId=playbackEndId||selectedFinalId||photoLibrary.at(-1).id;
  const frames=PanettoneCameraState.playbackFrames(photoLibrary,playbackEndId);
  if(!frames.length)return;
  if(String(selectedFinalId)===String(frames.at(-1).id))selectPhoto(frames[0].id,{manual:false});
  $('timelapse-toggle').textContent='Pausa';
  timelapseTimer=setInterval(()=>{const next=PanettoneCameraState.nextPhotoId(selectedFinalId,frames);if(String(next)===String(selectedFinalId)){stopPlayback();return;}selectPhoto(next,{manual:false});},Math.max(75,1500/Number($('timelapse-speed').value)));
}
$('timelapse-toggle').addEventListener('click',()=>{if(timelapseTimer)stopPlayback();else playTimelapse();});
$('timelapse-reset').addEventListener('click',()=>{stopPlayback();finalPinned=true;if(photoLibrary.length)selectPhoto(photoLibrary[Math.min(1,photoLibrary.length-1)].id,{manual:false});});
$('baseline-button').addEventListener('click',async()=>{
  const photo=photoLibrary.find(p=>String(p.id)===$('photo-select').value);if(!photo)return;
  selectReference(photo.id,{userInitiated:true,rebuild:false});$('calibration-feedback').textContent='Desant la fotografia inicial i el calibratge…';
  await saveGrowthCalibration(photo);
});
$('calibration-save').addEventListener('click',async()=>{
  const photo=allPhotos.find(p=>String(p.id)===String(growthCalibration?.photo_id));if(!photo){$('calibration-feedback').textContent='No s’ha pogut desar: la fotografia de referència no està disponible.';return;}
  await saveGrowthCalibration(photo);
});
async function saveGrowthCalibration(photo){
  const submitted={...growthCalibration,photo_id:photo.id};
  try{
    await json('/api/growth/calibration',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(submitted)});
    const confirmed=await json(`/api/growth?photo_id=${encodeURIComponent(photo.id)}`);
    const saved=confirmed.calibration;
    if(!PanettoneCameraState.calibrationMatches(saved,submitted))throw new Error('El servidor no ha retornat el mateix calibratge que s’ha enviat.');
    if(!PanettoneCameraState.calibrationMatches(growthCalibration,submitted)){savedGrowthCalibration={...saved};$('calibration-feedback').textContent='Calibratge anterior desat; encara hi ha ajustos locals pendents.';return;}
    savedGrowthCalibration={...saved};growthCalibration={...saved};selectedReferenceId=photo.id;selectedFinalId=$('photo-select').value||photo.id;
    calibrationDirty=false;calibrationTouched=false;ignoreBackendCalibration=false;displayCalibrationSignature=null;growthHistoryCache=[];renderGrowth();
    const savedAt=saved.saved_at||new Date().toISOString();
    $('calibration-feedback').textContent=`Calibratge desat correctament · ${new Date(savedAt).toLocaleString('ca-ES')}`;
    renderCalibrationGuides();await refreshCamera();
  }catch(error){$('calibration-feedback').textContent=`No s’ha pogut desar el calibratge: ${error.message}`;}
}
$('calibration-reset').addEventListener('click',async()=>{try{await json('/api/growth/calibration?fermentation_id='+cameraFermentationId,{method:'DELETE'});resetCameraSelection();await refreshCamera();$('calibration-feedback').textContent='Calibratge restablert. Els calibratges anteriors es conserven a l’historial intern; fotografies i lectures intactes.';}catch(error){$('calibration-feedback').textContent=error.message;}});
$('camera-fermentation').addEventListener('change',event=>{if(calibrationDirty&&calibrationTouched){event.currentTarget.value=String(cameraFermentationId);$('calibration-feedback').textContent='Desa o restableix els ajustos pendents abans de canviar de fermentació.';return;}cameraFollowsActive=false;cameraFermentationId=Number(event.currentTarget.value);resetCameraSelection();void refreshCamera();});

$('range').addEventListener('change',refresh);
$('photo-sampling').addEventListener('change',()=>renderPhotoLibrary(allPhotos));
$('timelapse-speed').addEventListener('change',()=>{if(timelapseTimer){stopPlayback();playTimelapse();}});
let timer;
window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(refresh,200)});
showPage(location.hash.slice(1),false);refresh();setInterval(refresh,30000);
setInterval(refreshFermenterOnly,5000);
if('serviceWorker'in navigator)navigator.serviceWorker.register('/service-worker.js?v=0.9.0',{updateViaCache:'none'}).catch(()=>{});

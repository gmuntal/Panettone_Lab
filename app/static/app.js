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
  const valid=rows.filter(row=>Number.isFinite(row.growth_score)).reverse();
  $('growth-empty').style.display=valid.length?'none':'grid';if(!valid.length)return;
  const vals=valid.map(row=>row.growth_score),min=Math.max(0,Math.floor((Math.min(...vals)-.08)*10)/10),max=Math.min(1,Math.ceil((Math.max(...vals)+.08)*10)/10);
  const range=Math.max(.15,max-min),low=Math.max(0,min),high=Math.min(1,low+range);
  ctx.font='10px sans-serif';ctx.fillStyle='#9aa69f';ctx.strokeStyle='#edf0ed';ctx.lineWidth=1;
  for(let i=0;i<4;i++){const ratio=i/3,y=p.t+(h-p.t-p.b)*ratio;ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();ctx.fillText(`${Math.round((high-(high-low)*ratio)*100)}%`,0,y+3)}
  ctx.strokeStyle='#4a9878';ctx.lineWidth=2;ctx.lineJoin='round';ctx.beginPath();
  valid.forEach((row,i)=>{const x=p.l+(w-p.l-p.r)*i/Math.max(1,valid.length-1),y=p.t+(h-p.t-p.b)*(1-(row.growth_score-low)/(high-low||1));if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke();
  const first=new Date(valid[0].captured_at),last=new Date(valid.at(-1).captured_at);ctx.fillStyle='#9aa69f';
  ctx.fillText(new Intl.DateTimeFormat('ca-ES',{hour:'2-digit',minute:'2-digit'}).format(first),p.l,h-4);
  ctx.fillText(new Intl.DateTimeFormat('ca-ES',{hour:'2-digit',minute:'2-digit'}).format(last),Math.max(p.l,w-p.r-35),h-4);
}

function renderGrowth(data) {
  const photo=data.photo,measurement=data.measurement;
  if(!measurement?.valid||!photo){
    $('growth-level').textContent='Sense detecció fiable';
    $('growth-detail').textContent='Revisa la zona del pot i la il·luminació de la captura.';
    $('growth-change').textContent=data.baseline?'Referència desada':'Cal una captura clara';
    $('growth-change').className='growth-change muted-change';
  }else{
    $('growth-level').textContent=`Alçada estimada · ${Math.round(photo.growth_score*100)}% de la zona`;
    $('growth-change').className=`growth-change ${data.direction}`;
    if(data.change_points===null){
      $('growth-change').textContent='Sense referència';
      $('growth-detail').textContent='Transició visual detectada · Marca el nivell inicial quan el pot estigui a punt.';
    }else{
      const sign=data.change_points>0?'+':'';
      const label={pujant:'Pujant',baixant:'Baixant',estable:'Estable'}[data.direction]||'Canvi visual';
      $('growth-change').textContent=`${label} · ${sign}${data.change_points} punts`;
      $('growth-detail').textContent=`Comparat amb ${fmtTime(data.baseline.captured_at)} · seguiment visual continu.`;
    }
  }
  $('baseline-button').disabled=!measurement?.valid || (measurement.confidence||0)<.45;
  $('baseline-button').textContent=data.baseline?'Reinicia el nivell inicial':'Marca el nivell inicial';
  if(photo?.filename&&!freshPreviewUrl){
    const image=$('growth-preview');
    const url=`/photos/${encodeURIComponent(photo.filename)}`;
    if(image.dataset.photo!==url){image.src=url;image.dataset.photo=url;}
  }
  renderRoi(data.roi);
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

let roi = {x0:.36,y0:.32,x1:.58,y1:.95};
let roiDrag = null;
function renderRoi(value) {
  if(value)roi={...value};
  const box=$('roi-box');
  box.style.left=`${roi.x0*100}%`;box.style.top=`${roi.y0*100}%`;
  box.style.width=`${(roi.x1-roi.x0)*100}%`;box.style.height=`${(roi.y1-roi.y0)*100}%`;
}
function pointerPosition(event) {
  const rect=$('growth-preview').getBoundingClientRect();
  return {x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};
}
$('growth-preview').addEventListener('pointerdown',event=>{
  if(!event.isPrimary)return;event.preventDefault();$('growth-preview').setPointerCapture(event.pointerId);
  roiDrag=pointerPosition(event);roi={x0:roiDrag.x,y0:roiDrag.y,x1:roiDrag.x,y1:roiDrag.y};renderRoi();
});
$('growth-preview').addEventListener('pointermove',event=>{
  if(!roiDrag)return;const point=pointerPosition(event);
  roi={x0:Math.min(roiDrag.x,point.x),y0:Math.min(roiDrag.y,point.y),x1:Math.max(roiDrag.x,point.x),y1:Math.max(roiDrag.y,point.y)};renderRoi();
});
const finishRoi=()=>{roiDrag=null;};
$('growth-preview').addEventListener('pointerup',finishRoi);$('growth-preview').addEventListener('pointercancel',finishRoi);

const calibration=$('growth-calibration'),roiMessage=$('roi-message'),saveRoiButton=$('save-roi'),testRoiButton=$('test-roi');
let previewRequest=null;
async function captureRoiPreview(){
  const image=$('growth-preview');
  previewRequest?.abort();const controller=new AbortController();previewRequest=controller;
  testRoiButton.disabled=true;saveRoiButton.disabled=true;
  roiMessage.textContent='Capturant i comprovant aquesta zona…';
  try{
    const response=await fetch('/api/growth/preview',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({roi}),signal:controller.signal});
    if(response.status===401){location.href='/login';throw new Error('Sessió caducada');}
    if(!response.ok){const payload=await response.json();throw new Error(payload.error||'No s’ha pogut capturar la imatge.');}
    const valid=response.headers.get('X-Growth-Valid')==='true';
    const score=Number(response.headers.get('X-Growth-Score'));
    const confidence=Number(response.headers.get('X-Growth-Confidence'));
    const blob=await response.blob();
    if(!calibration.open)return;
    if(freshPreviewUrl)URL.revokeObjectURL(freshPreviewUrl);
    freshPreviewUrl=URL.createObjectURL(blob);image.dataset.photo='fresh-preview';
    const loaded=new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('No s’ha pogut mostrar la captura actual.'));});
    image.src=freshPreviewUrl;await loaded;
    saveRoiButton.disabled=false;testRoiButton.disabled=false;
    roiMessage.textContent=valid
      ? `Detecció provisional: ${Math.round(score*100)}% de la zona · confiança ${Math.round(confidence*100)}%. Captura no desada.`
      : 'Aquesta captura no mostra una transició prou clara. Ajusta la zona o la il·luminació i torna-ho a provar. Captura no desada.';
    renderRoi();
  }catch(error){
    if(error.name!=='AbortError'){roiMessage.textContent=error.message==='Sessió caducada'?error.message:`${error.message} Torna-ho a provar.`;testRoiButton.disabled=false;}
  }finally{if(previewRequest===controller)previewRequest=null;}
}
calibration.addEventListener('toggle',async()=>{
  const image=$('growth-preview');
  if(!calibration.open){
    previewRequest?.abort();previewRequest=null;
    if(freshPreviewUrl){URL.revokeObjectURL(freshPreviewUrl);freshPreviewUrl=null;}
    image.removeAttribute('src');image.dataset.photo='';saveRoiButton.disabled=true;testRoiButton.disabled=true;
    return;
  }
  await captureRoiPreview();
});
testRoiButton.addEventListener('click',captureRoiPreview);

function renderFermenter(data,historyData=null) {
  historyData=historyData||fermenterHistoryCache;
  const {config,runtime,schedule}=data,form=$('fermenter-form');
  $('fermenter-temperature').textContent=runtime.temperature_c===null?'— °C':`${Number(runtime.temperature_c).toFixed(1)} °C`;
  $('fermenter-target').textContent=`${Number(config.target_c).toFixed(1).replace('.',',')} °C`;
  $('fermenter-mode-label').textContent={stopped:'Aturat',automatic:'Automàtic · simulació',manual:'Manual · simulació'}[config.mode]||config.mode;
  $('fermenter-heater').textContent=runtime.simulated_heater_on?'ON · SIMULAT':'OFF · SIMULAT';
  $('fermenter-heater').classList.toggle('sim-on',Boolean(runtime.simulated_heater_on));
  const fresh=runtime.sensor_fresh;
  $('fermenter-sensor-status').textContent=fresh?`DHT22 · fa ${runtime.sensor_age_seconds}s`:`Sense lectura fiable · ${runtime.error||'dada caducada'}`;
  $('fermenter-sensor-status').style.color=fresh?'':'var(--red)';
  const outputs=[runtime.switch0_on,runtime.switch1_on].map((value,i)=>`Canal ${i} ${value===null?'?':value?'ON':'OFF'}`).join(' · ');
  $('fermenter-physical-outputs').textContent=`Sortides físiques Shelly (càrrega no identificada): ${outputs}`;
  $('home-control-mode').textContent=`Control en simulació · ${{stopped:'Aturat',automatic:'Automàtic',manual:'Manual'}[config.mode]||config.mode}`;
  $('home-control-target').textContent=`${Number(config.target_c).toFixed(1).replace('.',',')} °C`;
  $('home-control-demand').textContent=runtime.simulated_heater_on?'ON · SIMULAT':'OFF · SIMULAT';
  $('home-physical-output').textContent=outputs;
  const since=runtime.heater_on_since?Math.max(0,Math.floor((Date.now()-new Date(runtime.heater_on_since))/1000)):null;
  $('fermenter-timer').textContent=runtime.simulated_heater_on&&since!==null?`Encès simulat · ${Math.floor(since/60)} min ${since%60}s`:`${runtime.reason||'Aturat'}`;
  $('fermenter-schedule').textContent=schedule.next_change?`${schedule.label} · canvi ${fmtTime(schedule.next_change)}`:schedule.label;
  $('fermenter-alert').hidden=!(runtime.error||runtime.lockout_reason||(!fresh&&runtime.observed_at));
  $('fermenter-alert').textContent=runtime.lockout_reason?`ALARMA BLOQUEJADA: ${runtime.lockout_reason}. La demanda simulada és OFF.`:runtime.error?`Alarma de comunicació: ${runtime.error}. Demanda simulada OFF.`:!fresh&&runtime.observed_at?'La lectura del DHT22 és massa antiga. Demanda simulada OFF.':'';
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
  if(!$('camera-compare').hidden)renderComparison();
}
function renderComparison(){
  const photo=photoLibrary.find(item=>String(item.id)===$('photo-compare-select').value);
  if(!photo)return;
  $('camera-compare-image').src=`/photos/${encodeURIComponent(photo.filename)}`;
  $('camera-compare-time').textContent=new Date(photo.captured_at).toLocaleString('ca-ES');
}
function renderPhotoLibrary(rows){
  const selected=$('photo-select').value,compareSelected=$('photo-compare-select').value;
  photoLibrary=rows.filter(item=>item.camera_ok&&item.filename).slice().reverse();
  $('camera-library-count').textContent=`${photoLibrary.length} ${photoLibrary.length===1?'imatge':'imatges'}`;
  const currentSelect=$('photo-select'),comparisonSelect=$('photo-compare-select');
  currentSelect.replaceChildren();comparisonSelect.replaceChildren();
  photoLibrary.forEach((photo,index)=>{
    const label=`${new Date(photo.captured_at).toLocaleString('ca-ES')}${photo.fermentation_id?` · #${photo.fermentation_id}`:''}`;
    for(const select of [currentSelect,comparisonSelect]){const option=document.createElement('option');option.value=String(photo.id);option.textContent=label;select.append(option);}
  });
  if(!photoLibrary.length){currentSelect.innerHTML='<option value="">Encara no hi ha captures</option>';comparisonSelect.replaceChildren();$('camera-current-image').removeAttribute('src');$('camera-current-time').textContent='No hi ha captures disponibles.';return;}
  currentSelect.value=photoLibrary.some(photo=>String(photo.id)===selected)?selected:String(photoLibrary.at(-1).id);
  comparisonSelect.value=photoLibrary.some(photo=>String(photo.id)===compareSelected)?compareSelected:String(photoLibrary[Math.max(0,photoLibrary.length-2)].id);
  selectPhoto(currentSelect.value);renderComparison();
  const grid=$('photo-grid');grid.replaceChildren();
  const recent=photoLibrary.slice(-24).reverse();
  $('photo-count').textContent=`${photoLibrary.length} ${photoLibrary.length===1?'imatge':'imatges'}`;
  recent.forEach(item=>{const a=document.createElement('a');a.className='photo-item';a.href=`/photos/${encodeURIComponent(item.filename)}`;a.target='_blank';a.rel='noopener';
    const img=document.createElement('img');img.loading='lazy';img.src=a.href;img.alt=`Captura ${fmtTime(item.captured_at)}`;const time=document.createElement('time');time.textContent=fmtTime(item.captured_at);a.append(img,time);grid.append(a);});
}

async function refresh() {
  try {
    const [state,readings,photos,growth,growthHistory,monitoring,fermenter,fermenterHistoryData,fermentationData]=await Promise.all([
      json('/api/state'),json(`/api/readings?hours=${$('range').value}`),json('/api/photos?limit=500'),
      json('/api/growth'),json('/api/growth/history?limit=500'),json('/api/monitoring'),json('/api/fermenter'),
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
    drawChart(readings);drawGrowthChart(growthHistory);renderGrowth(growth);renderPhotoLibrary(photos);
    renderFermentations();
  }catch(error){if(error.message!=='Sessió caducada')console.warn('No s’ha pogut actualitzar el dashboard',error);}
}

$('photo-select').addEventListener('change',event=>selectPhoto(event.currentTarget.value));
$('photo-compare-select').addEventListener('change',renderComparison);
$('photo-previous').addEventListener('click',()=>{const i=photoLibrary.findIndex(photo=>String(photo.id)===$('photo-select').value);if(i>0)selectPhoto(photoLibrary[i-1].id);});
$('photo-next').addEventListener('click',()=>{const i=photoLibrary.findIndex(photo=>String(photo.id)===$('photo-select').value);if(i>=0&&i<photoLibrary.length-1)selectPhoto(photoLibrary[i+1].id);});
$('compare-toggle').addEventListener('click',event=>{const panel=$('camera-compare');panel.hidden=!panel.hidden;event.currentTarget.setAttribute('aria-pressed',String(!panel.hidden));event.currentTarget.textContent=panel.hidden?'Compara dues imatges':'Amaga la comparació';if(!panel.hidden)renderComparison();});
$('timelapse-toggle').addEventListener('click',event=>{
  if(timelapseTimer){clearInterval(timelapseTimer);timelapseTimer=null;event.currentTarget.textContent='Reprodueix timelapse';return;}
  if(photoLibrary.length<2)return;
  let index=0;event.currentTarget.textContent='Atura el timelapse';selectPhoto(photoLibrary[index].id);
  timelapseTimer=setInterval(()=>{index=(index+1)%photoLibrary.length;selectPhoto(photoLibrary[index].id);},1500);
});

$('baseline-button').addEventListener('click',async()=>{
  $('growth-detail').textContent='Desant el nivell d’aquesta captura com a referència…';
  try{await json('/api/growth/calibrate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await refresh();}
  catch(error){$('growth-detail').textContent=error.message;}
});
$('save-roi').addEventListener('click',async()=>{
  $('roi-message').textContent='Desant i comprovant la zona…';
  try{const data=await json('/api/growth/roi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(roi)});renderGrowth(data);$('roi-message').textContent='Zona desada. La captura següent farà servir aquest retall.';await refresh();}
  catch(error){$('roi-message').textContent=`No s’ha pogut desar: ${error.message}`;}
});

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
  try{const result=await json('/api/fermenter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});renderFermenter(result);feedback.textContent='Configuració desada. Només afecta la simulació.';}
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

$('range').addEventListener('change',refresh);let timer;
window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(refresh,200)});
showPage(location.hash.slice(1),false);refresh();setInterval(refresh,30000);
setInterval(refreshFermenterOnly,5000);
if('serviceWorker'in navigator)navigator.serviceWorker.register('/service-worker.js?v=0.7.0',{updateViaCache:'none'}).catch(()=>{});

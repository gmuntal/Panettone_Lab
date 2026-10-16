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

const calibration=$('growth-calibration'),roiMessage=$('roi-message'),saveRoiButton=$('save-roi');
let previewRequest=null;
calibration.addEventListener('toggle',async()=>{
  const image=$('growth-preview');
  if(!calibration.open){
    previewRequest?.abort();previewRequest=null;
    if(freshPreviewUrl){URL.revokeObjectURL(freshPreviewUrl);freshPreviewUrl=null;}
    image.removeAttribute('src');image.dataset.photo='';saveRoiButton.disabled=true;
    return;
  }
  previewRequest?.abort();const controller=new AbortController();previewRequest=controller;saveRoiButton.disabled=true;
  roiMessage.textContent='Capturant una imatge actual de la càmera…';
  try{
    const response=await fetch('/api/growth/preview',{method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if(response.status===401){location.href='/login';throw new Error('Sessió caducada');}
    if(!response.ok){const payload=await response.json();throw new Error(payload.error||'No s’ha pogut capturar la imatge.');}
    const blob=await response.blob();
    if(!calibration.open)return;
    if(freshPreviewUrl)URL.revokeObjectURL(freshPreviewUrl);
    freshPreviewUrl=URL.createObjectURL(blob);image.dataset.photo='fresh-preview';
    const loaded=new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('No s’ha pogut mostrar la captura actual.'));});
    image.src=freshPreviewUrl;await loaded;
    saveRoiButton.disabled=false;roiMessage.textContent='Captura actual de la càmera; no es desa a l’historial.';
    renderRoi();
  }catch(error){
    if(error.name!=='AbortError')roiMessage.textContent=error.message==='Sessió caducada'?error.message:`${error.message} Tanca i torna a obrir la configuració per provar-ho de nou.`;
  }finally{if(previewRequest===controller)previewRequest=null;}
});

async function refresh() {
  try {
    const [state,readings,photos,growth,history,monitoring]=await Promise.all([
      json('/api/state'),json(`/api/readings?hours=${$('range').value}`),json('/api/photos?limit=24'),
      json('/api/growth'),json('/api/growth/history?limit=500'),json('/api/monitoring')
    ]);
    renderMonitoring(monitoring);
    const reading=state.reading;
    if(reading&&reading.sensor_ok){$('temperature').innerHTML=`${Number(reading.temperature_c).toFixed(1)}<small>°C</small>`;$('humidity').innerHTML=`${Number(reading.humidity_rh).toFixed(1)}<small>%</small>`;$('temperature-time').textContent=`Darrera lectura · ${fmtTime(reading.captured_at)}`;$('humidity-time').textContent='Relativa de l’ambient';}
    else if(reading){$('temperature-time').textContent='No s’ha pogut llegir el Shelly';$('humidity-time').textContent=`Darrera prova · ${fmtTime(reading.captured_at)}`;}
    const photo=state.photo,camera=$('camera-status');
    if(photo){$('photo-time').textContent=`Darrera captura · ${fmtTime(photo.captured_at)}`;camera.className=monitoring.active?`camera-status ${photo.camera_ok?'ok':'bad'}`:'camera-status paused';camera.querySelector('span').textContent=monitoring.active?(photo.camera_ok?'Connectada':'Sense connexió'):'Seguiment aturat';}
    drawChart(readings);drawGrowthChart(history);renderGrowth(growth);
    $('photo-count').textContent=`${photos.length} ${photos.length===1?'imatge':'imatges'}`;
    const grid=$('photo-grid');grid.replaceChildren();
    if(!photos.length)grid.innerHTML='<p class="muted empty-photo">Les captures apareixeran quan la càmera estigui connectada.</p>';
    else photos.filter(item=>item.camera_ok&&item.filename).forEach(item=>{
      const a=document.createElement('a');a.className='photo-item';a.href=`/photos/${encodeURIComponent(item.filename)}`;a.target='_blank';a.rel='noopener';
      const img=document.createElement('img');img.loading='lazy';img.src=a.href;img.alt=`Captura ${fmtTime(item.captured_at)}`;
      const time=document.createElement('time');time.textContent=fmtTime(item.captured_at);a.append(img,time);grid.append(a);
    });
  }catch(error){if(error.message!=='Sessió caducada')console.warn('No s’ha pogut actualitzar el dashboard',error);}
}

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

$('range').addEventListener('change',refresh);let timer;
window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(refresh,200)});
refresh();setInterval(refresh,30000);
if('serviceWorker'in navigator)navigator.serviceWorker.register('/service-worker.js').catch(()=>{});

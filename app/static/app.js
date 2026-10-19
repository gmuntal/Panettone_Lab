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
    ? `Fermentació #${activeFermentation.id} activa des de ${fmtTime(activeFermentation.started_at)}. Les lectures ambientals s’hi associen${activeFermentation.camera_enabled?' i el seguiment fotogràfic està actiu.':'; les fotografies estan pausades en aquesta sessió.'}`
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
    $('export-active-fermentation').href=`/api/fermentations/${current.id}/export`;$('export-active-fermentation').dataset.exportUrl=`/api/fermentations/${current.id}/export`;$('export-active-fermentation').hidden=false;
  }else{
    $('fermentation-detail-status').textContent='No hi ha cap fermentació activa. Pots iniciar-ne una al formulari de registre.';
    $('fermentation-detail-grid').replaceChildren();$('fermentation-timeline').replaceChildren();$('export-active-fermentation').hidden=true;$('export-active-fermentation').dataset.exportUrl='';
  }
  const sort=$('fermentation-sort')?.value||'date';const older=fermentationsCache.filter(item=>item.ended_at).slice().sort((a,b)=>sort==='storage'?(b.storage?.photo_bytes||0)-(a.storage?.photo_bytes||0):sort==='photos'?(b.storage?.available_photos||0)-(a.storage?.available_photos||0):new Date(b.started_at)-new Date(a.started_at)),list=$('fermentation-history');
  $('fermentation-count').textContent=`${older.length} ${older.length===1?'anterior':'anteriors'}`;list.replaceChildren();
  if(!older.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Encara no hi ha fermentacions finalitzades guardades.';list.append(empty);return;}
  older.forEach(item=>{const card=document.createElement('article');card.className='history-item';const head=document.createElement('div');const title=document.createElement('h3');title.textContent=`Fermentació #${item.id}`;const dates=document.createElement('p');dates.textContent=`${new Date(item.started_at).toLocaleString('ca-ES')} – ${new Date(item.ended_at).toLocaleString('ca-ES')}`;head.append(title,dates);const summary=document.createElement('p');const lastPh=(item.events||[]).filter(event=>event.ph!==null).at(-1);summary.textContent=`pH inicial ${item.initial_ph===null?'no registrat':Number(item.initial_ph).toFixed(2)} · darrer pH ${lastPh?Number(lastPh.ph).toFixed(2):'no registrat'} · ${(item.events||[]).filter(event=>event.event_type==='refresh').length} refrescos · ${(item.events||[]).length} anotacions`;
    const details=document.createElement('details');const label=document.createElement('summary');label.textContent='Mesures i refrescos';const eventList=document.createElement('ol');(item.events||[]).forEach(event=>{const li=document.createElement('li');li.textContent=`${new Date(event.occurred_at).toLocaleString('ca-ES')} · ${eventLabels[event.event_type]||event.event_type}${event.ph!==null?` · pH ${Number(event.ph).toFixed(2)}`:''}${event.details?` · ${event.details}`:''}`;eventList.append(li);});details.append(label,eventList);card.append(head,summary,details);if(!item.archived_at){const exportLink=document.createElement('a');exportLink.className='secondary-button';exportLink.href=`/api/fermentations/${item.id}/export`;exportLink.textContent='Descarrega ZIP complet';card.append(exportLink);}
    const storage=item.storage;if(storage){const usage=document.createElement('p');usage.textContent=`${storage.status} · ${storage.available_photos} fotografies disponibles · ${formatBytes(storage.photo_bytes)} · ${elapsedSince(item.started_at)}`;card.append(usage);}
    if(item.archived_at){const archiveNote=document.createElement('p');archiveNote.textContent=`Arxivada · ${item.archive_saved_bytes?formatBytes(item.archive_saved_bytes)+' alliberats en fotos':''} · mostreig ${item.archive_sample_minutes||30} min`;card.append(archiveNote);if(item.archive_filename){const dl=document.createElement('a');dl.className='secondary-button';dl.href=`/api/fermentations/${item.id}/archive`;dl.textContent='Descarrega ZIP de recuperació';card.append(dl);const remove=document.createElement('button');remove.type='button';remove.className='secondary-button';remove.textContent='Elimina còpia ZIP de la Raspberry';remove.addEventListener('click',async()=>{if(!window.confirm('Elimina la còpia de recuperació de la Raspberry? Continua només si ja has descarregat i comprovat el ZIP al teu dispositiu.'))return;try{await json(`/api/fermentations/${item.id}/archive/remove`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed_download:true})});await refreshFermentation();}catch(error){window.alert(error.message);}});card.append(remove);}}
    if(!item.archived_at)card.append(createPeriodTools(item));
    if(item.archived_at)list.append(card);else card.append(createArchiveTools(item));list.append(card);});
}

function localDateTimeInput(value){
  const date=new Date(value),offset=date.getTimezoneOffset()*60000;
  return new Date(date.getTime()-offset).toISOString().slice(0,16);
}
function createPeriodTools(item){
  const details=document.createElement('details');details.className='period-tools';
  const summary=document.createElement('summary');summary.textContent='Ajusta el període de la fermentació';details.append(summary);
  const note=document.createElement('p');note.className='metric-foot';note.textContent='L’ajust conserva totes les lectures i fotografies. Només canvia el període que es mostra i s’exporta.';details.append(note);
  const form=document.createElement('form');form.className='period-form';
  const startLabel=document.createElement('label');startLabel.textContent='Inici';const start=document.createElement('input');start.type='datetime-local';start.required=true;start.value=localDateTimeInput(item.started_at);startLabel.append(start);
  const endLabel=document.createElement('label');endLabel.textContent='Final';const end=document.createElement('input');end.type='datetime-local';end.required=true;end.value=localDateTimeInput(item.ended_at);endLabel.append(end);
  const preview=document.createElement('button');preview.type='button';preview.className='secondary-button';preview.textContent='Previsualitza';
  const save=document.createElement('button');save.type='submit';save.className='secondary-button';save.textContent='Desa període';
  const status=document.createElement('p');status.className='metric-foot';status.setAttribute('role','status');
  form.append(startLabel,endLabel,preview,save,status);details.append(form);
  const values=()=>({start:new Date(start.value).toISOString(),end:new Date(end.value).toISOString()});
  preview.addEventListener('click',async()=>{try{if(!start.value||!end.value)throw new Error('Indica les dues dates.');const period=values();const result=await json(`/api/fermentations/${item.id}/period-preview?start=${encodeURIComponent(period.start)}&end=${encodeURIComponent(period.end)}`);status.textContent=`Durada ${Math.round(result.duration_new_seconds/3600)} h · ${result.photos_affected} fotos i ${result.readings_affected} lectures quedarien fora del període; no s’esborren. Espai corresponent: ${formatBytes(result.recoverable_bytes_estimate)}.`;}catch(error){status.textContent=error.message;}});
  form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;try{if(!start.value||!end.value)throw new Error('Indica les dues dates.');await json(`/api/fermentations/${item.id}/period`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values())});status.textContent='Període actualitzat. Les dades originals es conserven.';await refreshFermentation();}catch(error){status.textContent=error.message;}finally{save.disabled=false;}});
  return details;
}

function createArchiveTools(item){
  const details=document.createElement('details');details.className='archive-tools';const summary=document.createElement('summary');summary.textContent='Previsualitza l’arxivament intel·ligent';details.append(summary);
  const intro=document.createElement('p');intro.className='metric-foot';intro.textContent='Només per a fermentacions finalitzades. El ZIP complet es guarda primer a la Raspberry i es verifica abans de retirar fotografies intermèdies.';details.append(intro);
  const controls=document.createElement('div');controls.className='archive-controls';const label=document.createElement('label');label.textContent='Mostreig';const select=document.createElement('select');for(const minutes of [10,15,30,60]){const option=document.createElement('option');option.value=minutes;option.textContent=`Cada ${minutes} minuts`;option.selected=minutes===30;select.append(option);}label.append(select);const previewButton=document.createElement('button');previewButton.type='button';previewButton.className='secondary-button';previewButton.textContent='Calcula previsualització';controls.append(label,previewButton);details.append(controls);
  const results=document.createElement('div');results.className='archive-preview';details.append(results);
  previewButton.addEventListener('click',async()=>{previewButton.disabled=true;results.textContent='Calculant selecció…';try{const plan=await json(`/api/fermentations/${item.id}/archive-preview?sample_minutes=${select.value}`);renderArchivePreview(item,plan,results,previewButton,select);}catch(error){results.textContent=error.message;}finally{previewButton.disabled=false;}});
  return details;
}
function renderArchivePreview(item,plan,container,previewButton,select){
  container.replaceChildren();const summary=document.createElement('p');summary.textContent=`Originals: ${plan.original_count} · es conservaran: ${plan.kept_count} · s’eliminaran: ${plan.removed_count} · espai de fotos ${formatBytes(plan.original_bytes)} · estalvi brut estimat ${formatBytes(plan.estimated_savings_bytes)} (el ZIP complet continuarà ocupant espai fins que el descarreguis i n’esborris la còpia local).`;container.append(summary);
  const list=document.createElement('div');list.className='archive-photo-list';container.append(list);const checkboxes=[];
  plan.photos.filter(photo=>photo.camera_ok&&photo.filename).forEach(photo=>{const row=document.createElement('div');row.className='archive-photo';const keepLabel=document.createElement('label');keepLabel.className='archive-keep';const input=document.createElement('input');input.type='checkbox';input.checked=photo.keep;input.disabled=photo.required_reasons.length>0;input.dataset.photoId=photo.id;checkboxes.push(input);keepLabel.append(input);if(photo.photo_url){const image=document.createElement('img');image.loading='lazy';image.src=photo.photo_url;image.alt=`Fotografia ${fmtTime(photo.captured_at)}`;keepLabel.append(image);}const caption=document.createElement('span');caption.textContent=`${fmtTime(photo.captured_at)} · ${formatBytes(photo.size_bytes)}${photo.required_reasons.length?` · obligatòria: ${photo.required_reasons.join(', ')}`:''}`;keepLabel.append(caption);row.append(keepLabel);const importantLabel=document.createElement('label');importantLabel.className='archive-important';const important=document.createElement('input');important.type='checkbox';important.checked=Boolean(photo.important);importantLabel.append(important,document.createTextNode(' Important'));important.addEventListener('change',async()=>{important.disabled=true;try{await json(`/api/fermentations/${item.id}/photos/${photo.id}/important`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({important:important.checked})});input.checked=true;input.disabled=important.checked||photo.required_reasons.length>0;}catch(error){important.checked=!important.checked;window.alert(error.message);}finally{important.disabled=false;}});row.append(importantLabel);list.append(row);});
  const exportLink=document.createElement('a');exportLink.className='secondary-button';exportLink.href=`/api/fermentations/${item.id}/export`;exportLink.textContent='Descarrega el ZIP complet abans de continuar';container.append(exportLink);
  const confirmLabel=document.createElement('label');confirmLabel.className='archive-confirm';const confirm=document.createElement('input');confirm.type='checkbox';const text=document.createElement('span');text.textContent='He descarregat i comprovat el ZIP complet al meu dispositiu.';confirmLabel.append(confirm,text);container.append(confirmLabel);
  const archiveButton=document.createElement('button');archiveButton.type='button';archiveButton.className='secondary-button';archiveButton.textContent='Confirma i arxiva les fotos no seleccionades';archiveButton.disabled=true;confirm.addEventListener('change',()=>archiveButton.disabled=!confirm.checked);container.append(archiveButton);
  archiveButton.addEventListener('click',async()=>{if(!confirm.checked||!window.confirm('Arxiva aquesta fermentació? Es retiraran de la carpeta de fotos les imatges no seleccionades. La còpia ZIP completa es mantindrà a la Raspberry per recuperar-les.'))return;archiveButton.disabled=true;try{const result=await json(`/api/fermentations/${item.id}/archive`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sample_minutes:Number(select.value),keep_photo_ids:checkboxes.filter(box=>box.checked).map(box=>Number(box.dataset.photoId)),confirmed_export_download:true})});const feedback=document.createElement('p');feedback.textContent=`Arxivada. ${result.removed_count} fotografies retirades; ZIP verificat de ${formatBytes(result.archive_bytes)} conservat a la Raspberry.`;container.append(feedback);await refreshFermentation();}catch(error){archiveButton.disabled=false;const feedback=document.createElement('p');feedback.textContent=`No s’ha pogut arxivar: ${error.message}`;container.append(feedback);}});
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
  if(valid==='settings'){void refreshResources();void refreshPushState();}
  window.scrollTo({top:0,behavior:'auto'});
}

const formatBytes=value=>{if(!Number.isFinite(value))return 'No disponible';const units=['B','KB','MB','GB','TB'];let amount=value,index=0;while(amount>=1024&&index<units.length-1){amount/=1024;index++;}return `${amount.toFixed(index?1:0)} ${units[index]}`;};
async function refreshResources(){
  try{const data=await json('/api/resources'),system=data.system,app=data.application,disk=system.data_disk,memory=system.memory;
    $('resource-status').textContent=disk?`Disc de dades: ${formatBytes(disk.used_bytes)} ocupats de ${formatBytes(disk.total_bytes)} (${disk.used_percent}%) · ${formatBytes(disk.available_bytes)} disponibles.`:'No s’ha pogut llegir l’espai del disc.';
    const root=system.root_disk;const entries=[`Sistema: ${root?`${formatBytes(root.used_bytes)} de ${formatBytes(root.total_bytes)} ocupats (${root.used_percent}%) · ${formatBytes(root.available_bytes)} disponibles`:'No disponible'}`,`RAM: ${formatBytes(memory.used_bytes)} / ${formatBytes(memory.total_bytes)} (${memory.used_percent??'—'}%) · procés: ${formatBytes(memory.process_rss_bytes)}`,`Serveis: ${Object.entries(system.services||{}).map(([name,state])=>`${name} ${state}`).join(' · ')||'No disponible'}`,`Fotografies originals disponibles: ${app.photo_count??'—'} · ${formatBytes(app.photos_bytes)}`,`SQLite: ${formatBytes(app.sqlite_bytes)}`,`ZIPs d’arxivament locals: ${formatBytes(app.archives_bytes)} · còpies SQLite: ${formatBytes(app.backup_bytes)}`,`Fitxers temporals Panettone Lab: ${formatBytes(app.temporary_bytes)}`,`Logs: no consultables des del contenidor (Docker els conserva a stdout)`];
    $('resource-details').replaceChildren(...entries.map(text=>{const p=document.createElement('p');p.textContent=text;return p;}));
  }catch(error){$('resource-status').textContent=`No s’han pogut consultar els recursos: ${error.message}`;}
}
function base64ToBytes(value){const normalized=value.replace(/-/g,'+').replace(/_/g,'/');const raw=atob(normalized);return Uint8Array.from(raw,char=>char.charCodeAt(0));}
async function refreshPushState(){
  try{const data=await json('/api/push'),supported=window.isSecureContext&&'serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
    if(!supported){$('push-status').textContent='Aquest navegador o origen no admet notificacions push. Cal HTTPS segur; a iPhone, instal·la la PWA a la pantalla d’inici (iOS/iPadOS 16.4 o posterior).';$('push-enable').disabled=true;return;}
    const subscription=await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    $('push-status').textContent=!data.configured?'El servidor encara no té les claus VAPID configurades.':subscription?`Actives en aquest dispositiu · permís ${Notification.permission} · ${data.subscription_count} dispositiu(s) registrat(s).`: `Disponibles · permís ${Notification.permission} · ${data.subscription_count} dispositiu(s) registrat(s).`;
    $('push-enable').disabled=!data.configured||Notification.permission==='denied';$('push-test').disabled=!data.configured||!subscription;$('push-disable').hidden=!subscription;
    for(const input of document.querySelectorAll('[data-push-category]'))input.checked=Boolean(data.preferences[`${input.dataset.pushCategory}_enabled`]);
    const deviceSummary=(data.devices||[]).map((device,index)=>`Dispositiu ${index+1}: subscrit ${new Date(device.created_at).toLocaleString('ca-ES')}${device.last_sent_at?` · darrer enviament ${new Date(device.last_sent_at).toLocaleString('ca-ES')}`:''}${device.last_error?` · error ${device.last_error}`:''}`).join(' · ');
    if(data.last_notification||deviceSummary)$('push-feedback').textContent=[deviceSummary,data.last_notification?`Darrera notificació enviada: ${new Date(data.last_notification.sent_at).toLocaleString('ca-ES')} · ${data.last_notification.category}.`:null].filter(Boolean).join(' · ');
  }catch(error){$('push-status').textContent=`Estat de notificacions no disponible: ${error.message}`;}
}
document.querySelectorAll('[data-push-category]').forEach(input=>input.addEventListener('change',async()=>{try{const prefs=Object.fromEntries([...document.querySelectorAll('[data-push-category]')].map(item=>[item.dataset.pushCategory,item.checked]));await json('/api/push/preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(prefs)});}catch(error){$('push-feedback').textContent=error.message;}}));
$('push-enable').addEventListener('click',async()=>{
  $('push-feedback').textContent='Demanant permís i activant el dispositiu…';
  try{const permission=await Notification.requestPermission();if(permission!=='granted'){ $('push-feedback').textContent=permission==='denied'?'Permís denegat. Canvia’l a la configuració del navegador.':'Activació cancel·lada.';await refreshPushState();return;}
    const data=await json('/api/push'),registration=await navigator.serviceWorker.ready;
    const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:base64ToBytes(data.public_key)});
    await json('/api/push/subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(subscription)});$('push-feedback').textContent='Notificacions activades en aquest dispositiu.';await refreshPushState();
  }catch(error){$('push-feedback').textContent=`No s’han pogut activar les notificacions: ${error.message}`;}
});
$('push-test').addEventListener('click',async()=>{try{$('push-feedback').textContent='Enviant notificació de prova…';const sub=await (await navigator.serviceWorker.ready).pushManager.getSubscription();const result=await json('/api/push/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:sub?.endpoint})});$('push-feedback').textContent=`Prova enviada a ${result.sent} dispositiu(s).`;await refreshPushState();}catch(error){$('push-feedback').textContent=`Error en la prova: ${error.message}`;}});
$('push-disable').addEventListener('click',async()=>{try{const sub=await (await navigator.serviceWorker.ready).pushManager.getSubscription();if(sub){await json('/api/push/subscriptions',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})});await sub.unsubscribe();}$('push-feedback').textContent='Notificacions desactivades en aquest dispositiu.';await refreshPushState();}catch(error){$('push-feedback').textContent=error.message;}});

let exportInProgress=false;
if(document.addEventListener)document.addEventListener('click',async event=>{
  const link=event.target.closest('a.export-active, .history-item a[href*="/export"]');if(!link)return;event.preventDefault();
  if(exportInProgress)return;const url=link.dataset.exportUrl||link.getAttribute('href');if(!url||url==='#')return;
  exportInProgress=true;const feedback=$('export-feedback');if(feedback)feedback.textContent='Preparant el ZIP…';link.setAttribute('aria-busy','true');
  const exportWindow=window.open('about:blank','_blank');
  try{const response=await fetch(url,{credentials:'same-origin'});if(response.status===401){if(exportWindow)exportWindow.close();location.href='/login';return;}if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const blob=await response.blob(),name=(response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i)||[])[1]||`panettone_lab_${new Date().toISOString().slice(0,10)}.zip`;
    const file=new File([blob],name,{type:'application/zip'});const objectUrl=URL.createObjectURL(blob);
    if(exportWindow&&!exportWindow.closed){
      const doc=exportWindow.document;doc.title='Exportació · Panettone Lab';doc.body.replaceChildren();
      const style=doc.createElement('style');style.textContent='body{font:16px system-ui;max-width:620px;margin:12vh auto;padding:24px;color:#173b32;background:#f6f8f5}a,button{display:inline-block;margin:8px 8px 8px 0;padding:12px 16px;border:1px solid #d7e4dc;border-radius:10px;background:white;color:#174c42;font:inherit;text-decoration:none}';doc.head.append(style);
      const title=doc.createElement('h1');title.textContent='ZIP preparat';const note=doc.createElement('p');note.textContent='Desa el fitxer o comparteix-lo. Tanca aquesta pestanya i torna a Panettone Lab quan vulguis.';
      const download=doc.createElement('a');download.href=objectUrl;download.download=name;download.textContent='Descarrega el ZIP';
      const share=doc.createElement('button');share.type='button';share.textContent='Comparteix…';share.hidden=!(exportWindow.navigator.share&&exportWindow.navigator.canShare&&exportWindow.navigator.canShare({files:[file]}));
      share.addEventListener('click',async()=>{try{await exportWindow.navigator.share({files:[file],title:'Exportació Panettone Lab'});}catch(error){if(error.name!=='AbortError')note.textContent=`No s’ha pogut obrir el full de compartir: ${error.message}`;}});
      const back=doc.createElement('a');back.href='/#fermentations';back.textContent='Torna a Panettone Lab';doc.body.append(title,note,download,share,back);
      if(feedback)feedback.textContent='ZIP preparat en una pestanya separada. Panettone Lab continua obert.';
    }else if(feedback){feedback.replaceChildren(document.createTextNode('ZIP preparat. Desa’l des d’aquí: '));const download=document.createElement('a');download.href=objectUrl;download.download=name;download.target='_blank';download.rel='noopener';download.textContent='Descarrega ZIP';feedback.append(download);if(navigator.share&&navigator.canShare&&navigator.canShare({files:[file]})){const share=document.createElement('button');share.type='button';share.className='secondary-button';share.textContent='Comparteix…';share.addEventListener('click',async()=>{try{await navigator.share({files:[file],title:'Exportació Panettone Lab'});}catch(error){if(error.name!=='AbortError')feedback.append(document.createTextNode(` Error: ${error.message}`));}});feedback.append(share);}}
    else{const link=document.createElement('a');link.href=objectUrl;link.target='_blank';link.rel='noopener';link.textContent='Obre el ZIP';document.body.append(link);}
    setTimeout(()=>URL.revokeObjectURL(objectUrl),10*60*1000);
  }catch(error){if(exportWindow&&!exportWindow.closed){exportWindow.document.body.textContent=error.message;const back=exportWindow.document.createElement('a');back.href='/#fermentations';back.textContent='Torna a Panettone Lab';exportWindow.document.body.append(back);}if(error.name==='AbortError'){if(feedback)feedback.textContent='Exportació cancel·lada. Panettone Lab continua obert.';}else if(feedback)feedback.textContent=`No s’ha pogut preparar el ZIP: ${error.message}`;
  }finally{link.removeAttribute('aria-busy');exportInProgress=false;}
});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>showPage(button.dataset.view)));
document.querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',()=>showPage(button.dataset.go)));
window.addEventListener('hashchange',()=>showPage(location.hash.slice(1),false));
document.querySelectorAll('[data-fermentation-tab]').forEach(button=>button.addEventListener('click',()=>{
  const name=button.dataset.fermentationTab;
  document.querySelectorAll('[data-fermentation-tab]').forEach(tab=>{const selected=tab===button;tab.classList.toggle('is-selected',selected);tab.setAttribute('aria-selected',String(selected));});
  document.querySelectorAll('[data-fermentation-panel]').forEach(panel=>panel.hidden=panel.dataset.fermentationPanel!==name);
}));
document.querySelector('#fermentation-sort')?.addEventListener('change',renderFermentations);

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
  $('growth-level').textContent=calibrationDirty?'Calibratge pendent de desar':result?(threshold==='tripled'?'Massa triplicada':threshold==='doubled'?'Massa duplicada':'Creixement visual'):pending?'Analitzant la seqüència…':'Sense detecció fiable';
  $('growth-detail').textContent=result?`${fmtTime(photo.captured_at)} · ${photo.archived_at?'Anàlisi guardada abans de l’arxivament; original al ZIP':result.quality==='manual_reference'?'Referència manual':'Detecció correcta'} · estimació d’alçada`:calibrationDirty?'Desa els ajustos per recalcular.':photo?.measurement?.reason==='pending'?'Estimació pendent per a aquesta fotografia.':'No es pot detectar la superfície actual amb prou evidència.';
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

$('monitoring-button').addEventListener('click',async()=>{const button=$('monitoring-button');button.disabled=true;try{const result=await json('/api/monitoring',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:!button.classList.contains('stop')})});renderMonitoring(result);await refresh();}catch(error){window.alert(error.message);}finally{button.disabled=false;}});
$('fermenter-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,feedback=$('fermenter-feedback'),payload=Object.fromEntries(new FormData(form));for(const input of form.querySelectorAll('input[type=checkbox]'))payload[input.name]=input.checked;payload.max_on_seconds=Number(payload.max_on_seconds)*60;try{feedback.textContent='Desant configuració…';await json('/api/fermenter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});feedback.textContent='Configuració desada.';await refreshFermenterOnly();}catch(error){feedback.textContent=`No s’ha pogut desar: ${error.message}`;}});
document.querySelectorAll('.stepper [data-step]').forEach(button=>button.addEventListener('click',()=>{const input=button.parentElement.querySelector('input');input.value=(Number(input.value)+Number(button.dataset.step)).toFixed(1);input.dispatchEvent(new Event('change',{bubbles:true}));}));
$('blanket-test-start').addEventListener('click',async()=>{const seconds=Number($('blanket-test-duration').value);if(!window.confirm(`Iniciar una prova física de ${seconds} segons? Confirma que ets al costat de la fermentadora i que les proteccions físiques s’han revisat.`))return;const button=$('blanket-test-start');button.disabled=true;$('blanket-test-status').textContent='Demanant prova temporitzada…';try{await json('/api/fermenter/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({duration_seconds:seconds})});await refreshFermenterOnly();}catch(error){$('blanket-test-status').textContent=error.message;}finally{button.disabled=false;}});
$('blanket-test-stop').addEventListener('click',async()=>{if(!window.confirm('Demanar ara l’apagada de la manta?'))return;try{await json('/api/fermenter/test/stop',{method:'POST'});await refreshFermenterOnly();}catch(error){$('blanket-test-status').textContent=error.message;}});
$('fermentation-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,feedback=$('session-status'),payload=Object.fromEntries(new FormData(form));payload.camera_enabled=form.elements.camera_enabled.checked;try{await json('/api/fermentations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});form.reset();await refresh();}catch(error){feedback.textContent=`No s’ha pogut iniciar: ${error.message}`;}});
$('end-fermentation').addEventListener('click',async()=>{if(!activeFermentation||!window.confirm('Finalitzar aquesta fermentació?'))return;try{await json(`/api/fermentations/${activeFermentation.id}/end`,{method:'POST'});await refresh();}catch(error){window.alert(error.message);}});
$('event-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,payload=Object.fromEntries(new FormData(form));try{await json('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});form.reset();$('event-feedback').textContent='Anotació desada.';await refresh();}catch(error){$('event-feedback').textContent=`No s’ha pogut desar: ${error.message}`;}});

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
  const testActive=['starting','running'].includes(runtime.test_status)&&runtime.test_until;
  const testRemaining=testActive?Math.max(0,Math.ceil((new Date(runtime.test_until)-Date.now())/1000)):0;
  $('blanket-test-start').disabled=!real||!fresh||config.mode!=='stopped'||testActive||runtime.switch0_on!==false;
  $('blanket-test-stop').hidden=!testActive;
  $('blanket-test-status').textContent=testActive?`Prova en curs · apagada automàtica del Shelly en ${testRemaining} s.`:runtime.test_status==='completed'?'Darrera prova acabada i apagada confirmada.':runtime.test_status==='interrupted'?'Darrera prova interrompuda per un reinici; l’autoapagada local del Shelly havia de tallar-la.':!real?(data.physical_control_block_reason||'Prova bloquejada per seguretat.'):!fresh?'Prova bloquejada: lectura de temperatura no vàlida o antiga.':config.mode!=='stopped'?'Atura el control abans de provar.':runtime.switch0_on!==false?'Cal confirmar que switch:0 és OFF abans de provar.':'Prova física supervisada disponible.';
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
    if(photo){$('photo-time').textContent=`Darrera captura · ${fmtTime(photo.captured_at)}`;const cameraPaused=activeFermentation&& !activeFermentation.camera_enabled;camera.className=monitoring.active&&!cameraPaused?`camera-status ${photo.camera_ok?'ok':'bad'}`:'camera-status paused';camera.querySelector('span').textContent=cameraPaused?'Pausada en aquesta fermentació':monitoring.active?(photo.camera_ok?'Connectada':'Sense connexió'):'Seguiment aturat';}
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
if('serviceWorker'in navigator)navigator.serviceWorker.register('/service-worker.js?v=0.11.0',{updateViaCache:'none'}).catch(()=>{});

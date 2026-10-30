const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../app/static/app.js'), 'utf8');
const start = source.indexOf('function ageText(timestamp){');
const end = source.indexOf("$('monitoring-button').addEventListener", start);
const statusLogic = source.slice(start, end);

function mount() {
  const badgeText = {textContent:''};
  const badge = {className:'',dataset:{intervalSeconds:'30'},querySelector:()=>badgeText};
  const elements = {'sensor-freshness':badge,'temperature-time':{textContent:''},'humidity-time':{textContent:''}};
  const context = vm.createContext({
    $:id=>elements[id],
    fmtTime:value=>new Date(value).toISOString(),
    Date,Intl,Number,Math
  });
  vm.runInContext(statusLogic,context);
  return {context,badge,badgeText,elements};
}

test('recent readings are labelled with their own values and freshness',()=>{
  const ui=mount(),captured_at=new Date(Date.now()-30000).toISOString();
  ui.context.renderReadingFreshness({captured_at,temperature_c:25.2,humidity_rh:61.4,sensor_ok:1});
  assert.equal(ui.badge.className,'data-freshness fresh');
  assert.match(ui.badgeText.textContent,/dada recent/);
  assert.match(ui.elements['temperature-time'].textContent,/Temperatura vàlida/);
  assert.match(ui.elements['humidity-time'].textContent,/Humitat vàlida/);
});

test('a stale last valid value remains identified when the latest attempt failed',()=>{
  const ui=mount(),validAt=new Date(Date.now()-5*60000).toISOString(),failedAt=new Date(Date.now()-30000).toISOString();
  ui.context.renderReadingFreshness({captured_at:validAt,temperature_c:25.2,humidity_rh:61.4,sensor_ok:1},{captured_at:failedAt,sensor_ok:0});
  assert.equal(ui.badge.className,'data-freshness stale');
  assert.match(ui.elements['temperature-time'].textContent,/l’últim intent ha fallat/);
});

test('failed attempts with no valid history are distinct from no readings',()=>{
  const failed=mount();
  failed.context.renderReadingFreshness(null,{captured_at:new Date().toISOString(),sensor_ok:0});
  assert.match(failed.badgeText.textContent,/darrer intent fallit/);
  const empty=mount();
  empty.context.renderReadingFreshness(null,null);
  assert.match(empty.badgeText.textContent,/sense lectures/);
});

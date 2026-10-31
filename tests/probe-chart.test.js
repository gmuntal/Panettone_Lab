const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/static/app.js'), 'utf8');
const chartStateSource=fs.readFileSync(require.resolve('../app/static/chart-state.js'),'utf8');
const drawStart = source.indexOf('function drawChart(rows) {');
const eventStart = source.indexOf("\ndocument.querySelectorAll('[data-chart-series]')", drawStart);
const tableStart = source.indexOf('function renderChartTable(', eventStart);
const probeStart = source.indexOf('\nconst probeLabels=', tableStart);
const chart = source.slice(drawStart,eventStart)+source.slice(tableStart,probeStart);

function render(ambient, dough, visible={ambient:true,dough:true,humidity:true,growth:true},growth=[]) {
  const strokes = [], labels = [], empty = {style: {}}, tableBody = {children:[],replaceChildren(...nodes){this.children=nodes;},append(node){this.children.push(node);}};
  let path = [];
  const ctx = {
    scale() {}, beginPath() { path = []; },
    moveTo(x,y) { assert.ok(Number.isFinite(x)&&Number.isFinite(y)); path.push(['move',x,y]); },
    lineTo(x,y) { assert.ok(Number.isFinite(x)&&Number.isFinite(y)); path.push(['line',x,y]); },
    arc(x,y) { assert.ok(Number.isFinite(x)&&Number.isFinite(y)); }, fill() {},
    stroke() { strokes.push({color:this.strokeStyle,path:[...path]}); },
    fillText(text,x,y) { assert.ok(Number.isFinite(x)&&Number.isFinite(y)); labels.push(String(text)); }
  };
  const canvas = {getBoundingClientRect:()=>({width:350,height:210}),getContext:()=>ctx};
  const element = tag => ({tag,children:[],append(...nodes){this.children.push(...nodes);},set textContent(value){this.text=String(value);},get textContent(){return this.text;}});
  const window={devicePixelRatio:1};vm.runInNewContext(chartStateSource,{window,Date,Number,Math});
  const context = vm.createContext({window,probeReadingsCache:dough,chartGrowthRows:growth,chartSessionDomain:null,chartSeriesVisible:visible,lastChartPoints:[],cssToken:(_name,fallback)=>fallback,
    $: id=>id==='chart'?canvas:id==='chart-data-body'?tableBody:empty,
    document:{createElement:element}, Intl, Date, Number, Math});
  vm.runInContext(chart, context);
  context.rows = ambient;
  vm.runInContext('drawChart(rows)', context);
  return {strokes,empty,labels,tableBody};
}
const row=(seconds,temp,extra={})=>({captured_at:new Date(Date.UTC(2026,9,30,12,0,seconds)).toISOString(),temperature_c:temp,humidity_rh:null,sensor_ok:1,...extra});

test('mass-only and humidity-only histories produce finite canvas coordinates',()=>{
  assert.equal(render([],[row(0,21),row(30,22)]).empty.style.display,'none');
  assert.equal(render([row(0,null,{humidity_rh:60})],[]).empty.style.display,'none');
  assert.equal(render([],[]).empty.style.display,'grid');
});
test('ambient and mass temperatures share the Celsius axis; humidity has a labelled percent axis',()=>{
  const result=render([row(0,25),row(60,25)],[row(30,25),row(60,25)]);
  const ambient=result.strokes.find(s=>s.color==='#d77d2b').path;
  const dough=result.strokes.find(s=>s.color==='#557dce').path;
  assert.equal(ambient[0][2],dough[0][2]);
  assert.equal(dough[0][1],(ambient[0][1]+ambient[1][1])/2);
  const humidity=render([row(0,null,{humidity_rh:40}),row(60,null,{humidity_rh:60})],[]);
  assert.ok(humidity.labels.some(label=>label.includes('°')));
  assert.ok(humidity.labels.some(label=>label.includes('%')));
  assert.equal(humidity.tableBody.children.length,2);
});

test('chart shows a helpful message when every data series is hidden',()=>{
  const result=render([row(0,25),row(60,26)],[],{ambient:false,dough:false,humidity:false});
  assert.equal(result.empty.style.display,'grid');
  assert.match(result.empty.textContent,/almenys una sèrie/i);
});
test('invalid samples and long outages break the mass curve',()=>{
  const result=render([],[row(0,20),row(30,null,{sensor_ok:0}),row(60,21),row(300,22)]);
  const mass=result.strokes.find(s=>s.color==='#557dce').path;
  assert.ok(mass.every(point=>point[0]==='move'));
});

test('the unified chart includes growth on its separate labelled scale',()=>{
  const growth=[{captured_at:'2026-10-30T12:00:00Z',factor:1,source:'automatic'},
    {captured_at:'2026-10-30T12:02:00Z',factor:2,source:'manual'}];
  const result=render([row(0,25,{humidity_rh:55}),row(120,26,{humidity_rh:57})],
    [row(60,24)],{ambient:true,dough:true,humidity:true,growth:true},growth);
  const colors=new Set(result.strokes.map(stroke=>stroke.color));
  assert.ok(colors.has('#8056a8'));
  assert.ok(['#d77d2b','#557dce','#32906b','#8056a8'].every(color=>colors.has(color)));
  assert.ok(result.labels.some(label=>label.startsWith('×')));
  assert.equal(result.tableBody.children.length,7);
});

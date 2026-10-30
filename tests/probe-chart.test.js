const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/static/app.js'), 'utf8');
const chart = source.slice(source.indexOf('function drawChart(rows) {'), source.indexOf('\nconst probeLabels='));

function render(ambient, dough) {
  const strokes = [], labels = [], empty = {style: {}}, tableBody = {children:[],replaceChildren(...nodes){this.children=nodes;},append(node){this.children.push(node);}};
  let path = [];
  const ctx = {
    scale() {}, beginPath() { path = []; },
    moveTo(x,y) { assert.ok(Number.isFinite(x)&&Number.isFinite(y)); path.push(['move',x,y]); },
    lineTo(x,y) { assert.ok(Number.isFinite(x)&&Number.isFinite(y)); path.push(['line',x,y]); },
    stroke() { strokes.push({color:this.strokeStyle,path:[...path]}); },
    fillText(text,x,y) { assert.ok(Number.isFinite(x)&&Number.isFinite(y)); labels.push(String(text)); }
  };
  const canvas = {getBoundingClientRect:()=>({width:350,height:210}),getContext:()=>ctx};
  const element = tag => ({tag,children:[],append(...nodes){this.children.push(...nodes);},set textContent(value){this.text=String(value);},get textContent(){return this.text;}});
  const context = vm.createContext({window:{devicePixelRatio:1},probeReadingsCache:dough,
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
  const ambient=result.strokes.find(s=>s.color==='#3e9375').path;
  const dough=result.strokes.find(s=>s.color==='#557dce').path;
  assert.equal(ambient[0][2],dough[0][2]);
  assert.equal(dough[0][1],(ambient[0][1]+ambient[1][1])/2);
  const humidity=render([row(0,null,{humidity_rh:40}),row(60,null,{humidity_rh:60})],[]);
  assert.ok(humidity.labels.some(label=>label.includes('°')));
  assert.ok(humidity.labels.some(label=>label.includes('%')));
  assert.equal(humidity.tableBody.children.length,2);
});
test('invalid samples and long outages break the mass curve',()=>{
  const result=render([],[row(0,20),row(30,null,{sensor_ok:0}),row(60,21),row(300,22)]);
  const mass=result.strokes.find(s=>s.color==='#557dce').path;
  assert.ok(mass.every(point=>point[0]==='move'));
});

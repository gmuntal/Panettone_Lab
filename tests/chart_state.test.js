const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../app/static/chart-state.js'), 'utf8');
function api() {
  const window = {};
  vm.runInNewContext(source, { window, Date, Number, Math });
  return window.PanettoneChartState;
}

test('growth sequence prefers manual corrections and drops unreliable detections', () => {
  const state = api();
  const points = state.growthPoints([
    { id: 2, camera_ok: true, captured_at: '2026-10-31T02:00:30Z',
      measurement: { valid: true, quality: 'correct', factor: 1.8 },
      manual_measurement: { valid: true, quality: 'manual', factor: 2.1 } },
    { id: 1, camera_ok: true, captured_at: '2026-10-31T02:00:00Z',
      measurement: { valid: true, quality: 'uncertain', factor: 9 } },
    { id: 3, camera_ok: false, captured_at: '2026-10-31T02:01:00Z',
      measurement: { valid: true, quality: 'correct', factor: 3 } },
    { id: 4, camera_ok: true, captured_at: '2026-10-31T02:02:00Z',
      measurement: { valid: true, quality: 'unknown', factor: 3 } }
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0].factor, 2.1);
  assert.equal(points[0].source, 'manual');
});

test('nearest photo matches by actual timestamp and respects the time tolerance', () => {
  const state = api();
  const rows = [{ id: 1, captured_at: '2026-10-31T02:00:00Z' },
    { id: 2, captured_at: '2026-10-31T02:02:00Z' }];
  assert.equal(state.nearest(rows, '2026-10-31T02:01:20Z', 90000).id, 2);
  assert.equal(state.nearest(rows, '2026-10-31T02:05:00Z', 90000), null);
});

test('long missing intervals are not bridged as continuous growth', () => {
  const state = api();
  const rows = [{ captured_at: '2026-10-31T00:00:00Z' },
    { captured_at: '2026-10-31T00:02:00Z' },
    { captured_at: '2026-10-31T03:00:00Z' }];
  assert.equal(state.gapLimit(rows), 300000);
  assert.equal(state.domain(rows, { started_at: '2026-10-31T00:00:00Z', ended_at: null },
    Date.parse('2026-10-31T04:00:00Z'))[1], Date.parse('2026-10-31T04:00:00Z'));
});

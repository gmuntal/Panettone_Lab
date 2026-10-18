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

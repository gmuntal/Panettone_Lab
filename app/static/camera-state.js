(function (root) {
  const api = {
    firstPhotoAtOrAfter(photos, timestamp) {
      const start = new Date(timestamp).getTime();
      if (!Number.isFinite(start)) return null;
      return photos.slice().sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))
        .find(photo => new Date(photo.captured_at).getTime() >= start) || null;
    },
    preservePhotoId(currentId, eligiblePhotos) {
      return eligiblePhotos.some(photo => String(photo.id) === String(currentId))
        ? currentId : (eligiblePhotos.at(-1)?.id ?? null);
    },
    nextPhotoId(currentId, eligiblePhotos) {
      const index = eligiblePhotos.findIndex(photo => String(photo.id) === String(currentId));
      return index >= 0 && index < eligiblePhotos.length - 1 ? eligiblePhotos[index + 1].id : currentId;
    },
    shouldHydrateCalibration(isDirty, ignoreServerCalibration) {
      return !isDirty && !ignoreServerCalibration;
    },
    calibrationMatches(saved, submitted, tolerance = 0.00001) {
      if (!saved || String(saved.photo_id) !== String(submitted.photo_id)) return false;
      return ['left_x', 'right_x', 'bottom_y', 'initial_surface_y']
        .every(key => Math.abs(Number(saved[key]) - Number(submitted[key])) <= tolerance);
    },
    isLatestRequest(sequence, latestSequence) {
      return sequence === latestSequence;
    }
  };
  root.PanettoneCameraState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

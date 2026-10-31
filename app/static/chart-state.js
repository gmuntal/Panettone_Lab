(() => {
  const usable = value => Number.isFinite(Number(value)) && value !== null && value !== '';
  function growthPoints(frames = []) {
    return frames.map(frame => {
      const manual = frame.manual_measurement;
      const automatic = frame.measurement;
      const measurement = manual?.valid && usable(manual.factor) ? manual : automatic;
      if (!frame.camera_ok || !measurement?.valid || !usable(measurement.factor)) return null;
      if (!['correct', 'manual', 'manual_reference'].includes(measurement.quality)) return null;
      return { captured_at: frame.captured_at, factor: Number(measurement.factor), photo_id: frame.id,
        source: manual?.valid && measurement === manual ? 'manual' : 'automatic' };
    }).filter(Boolean).sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
  }
  function nearest(rows = [], time, maxDelta = Infinity) {
    const target = Date.parse(time);
    if (!Number.isFinite(target)) return null;
    let chosen = null, delta = Infinity;
    for (const row of rows) {
      const distance = Math.abs(Date.parse(row.captured_at) - target);
      if (Number.isFinite(distance) && distance < delta) { chosen = row; delta = distance; }
    }
    return delta <= maxDelta ? chosen : null;
  }
  function gapLimit(rows, fallback = 180000) {
    const gaps = rows.map((row, i) => i ? Date.parse(row.captured_at) - Date.parse(rows[i - 1].captured_at) : 0)
      .filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    return gaps.length ? Math.max(fallback, gaps[Math.floor((gaps.length - 1) / 2)] * 2.5) : Infinity;
  }
  function domain(rows, session, now = Date.now()) {
    if (session?.started_at) return [Date.parse(session.started_at), session.ended_at ? Date.parse(session.ended_at) : now];
    const times = rows.map(row => Date.parse(row.captured_at)).filter(Number.isFinite);
    return times.length ? [Math.min(...times), Math.max(...times)] : [now - 1, now];
  }
  window.PanettoneChartState = { growthPoints, nearest, gapLimit, domain };
})();

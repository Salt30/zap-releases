// Restoring saved settings must not silently clamp older/custom values to the
// current slider defaults, or turn a zero percentage into a whole-number step.
function setSavedRangeValue(control, saved) {
  const value = Number(saved);
  if (!Number.isFinite(value)) return;
  control.min = String(Math.min(Number(control.min), value));
  control.max = String(Math.max(Number(control.max), value));
  const step = Number(control.step);
  const steps = (value - Number(control.min)) / step;
  if (!(step > 0) || Math.abs(steps - Math.round(steps)) > 1e-7) {
    const decimals = String(value).split('.')[1]?.length || 0;
    control.step = String(Math.min(step > 0 ? step : 1, 10 ** -Math.min(decimals, 6)));
  }
  control.value = String(value);
}

module.exports = { setSavedRangeValue };

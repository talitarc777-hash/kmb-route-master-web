export function normalizeHeading(value) {
  if (value === null || value === undefined || value === '') return null;
  const heading = Number(value);
  if (!Number.isFinite(heading)) return null;
  return ((heading % 360) + 360) % 360;
}

export function headingFromDeviceOrientation(event, screenAngle = 0) {
  if (!event) return null;
  const webkitHeading = normalizeHeading(event.webkitCompassHeading);
  let heading = webkitHeading;

  if (heading === null) {
    const hasAbsoluteReference = event.absolute === true || event.type === 'deviceorientationabsolute';
    const alpha = normalizeHeading(event.alpha);
    if (!hasAbsoluteReference || alpha === null) return null;
    // Device-orientation alpha turns in the opposite direction to a compass bearing.
    heading = normalizeHeading(360 - alpha);
  }

  const displayOrientation = normalizeHeading(screenAngle) ?? 0;
  return normalizeHeading(heading + displayOrientation);
}

export function smoothHeading(previous, next, strength = 0.24) {
  const target = normalizeHeading(next);
  const current = normalizeHeading(previous);
  if (target === null) return current;
  if (current === null) return target;
  const ratio = Math.max(0, Math.min(1, Number(strength) || 0));
  const shortestTurn = ((target - current + 540) % 360) - 180;
  return normalizeHeading(current + shortestTurn * ratio);
}

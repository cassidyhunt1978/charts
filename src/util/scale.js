export function computeYDomain(values, padFrac = 0.08) {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (!isFinite(min) || !isFinite(max)) return { yMin: 0, yMax: 1 };
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * padFrac;
  return { yMin: min - pad, yMax: max + pad };
}

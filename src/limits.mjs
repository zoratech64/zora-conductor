/** Longest single duration zc accepts anywhere (8 hours). */
export const MAX_MINUTES = 480;

/**
 * Validate a duration in minutes. Accepts a finite number > 0 and <= MAX_MINUTES, or a plain decimal
 * string. Rejects NaN, Infinity, zero, negatives, empty and junk text such as "10m" or "1e3".
 */
export function parseMinutes(value, label = 'minutes') {
  let n = value;
  if (typeof value === 'string') {
    if (!/^\s*\d+(\.\d+)?\s*$/.test(value)) throw new Error(`${label} must be a plain number of minutes, got "${value}"`);
    n = Number(value);
  }
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a number greater than 0, got ${JSON.stringify(value)}`);
  if (n > MAX_MINUTES) throw new Error(`${label} must be at most ${MAX_MINUTES} minutes, got ${n}; split the task instead`);
  return n;
}

/** A positive integer within [min, max]. */
export function parseCount(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number from ${min} to ${max}, got ${JSON.stringify(value)}`);
  return value;
}

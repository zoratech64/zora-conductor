/**
 * Failure kinds a worker run can end in, and what the dispatcher does about each:
 *   license  account has no Antigravity license -> block that account for good
 *   location Google refuses where the call comes from -> stop; rotating accounts cannot fix it
 *   auth     sign-in expired -> account needs `zc account login`
 *   quota    rate/usage limit -> cooldown, switch to the next account
 *   server   Google-side 5xx -> one unchanged rerun, then treat the account as flaky
 */
const LICENSE = /SUBSCRIPTION_REQUIRED|do not have a valid license of this product|#3501/i;
const LOCATION = /User location is not supported|Account ineligible|not eligible for Antigravity|region.?restrict|unsupported (?:region|location)/i;
const AUTH = /authentication required|not authenticated|unauthenticated|please (?:sign|log) ?in|invalid_grant|token (?:has )?(?:expired|been revoked)|re-?authenticate/i;
const QUOTA = /quota|rate.?limit|resource.?exhaust|usage.?limit|too many requests|\b429\b/i;
const SERVER = /Internal error encountered|HTTP 500|\b50[0-4]\b[^\n]*(?:error|unavailable|gateway)|overloaded|\bUNAVAILABLE\b/i;

export function classify(text) {
  if (!text) return null;
  if (LICENSE.test(text)) return 'license';
  if (LOCATION.test(text)) return 'location';
  if (AUTH.test(text)) return 'auth';
  if (QUOTA.test(text)) return 'quota';
  if (SERVER.test(text)) return 'server';
  return null;
}

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };

/** Pull a retry/reset time out of a provider message; returns an epoch ms or null. */
export function parseResetHint(text, now = Date.now()) {
  const iso = /\b(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/.exec(text);
  if (iso) {
    const at = Date.parse(iso[1]);
    if (at > now) return at;
  }
  const rel = /(?:try again|retry|resets?|available)(?:\s+(?:in|after))?\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(text);
  if (rel) {
    const unit = rel[2][0].toLowerCase();
    return now + Number(rel[1]) * UNIT_MS[unit];
  }
  return null;
}

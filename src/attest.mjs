import { createInterface } from 'node:readline/promises';

/**
 * Manual attestation that one Google account is registered in exactly one
 * profile. ZC cannot check this: agy has no identity command and ZC never
 * reads token files. The control is a recorded, enforced human assertion.
 */

const MAX_LABEL = 64;

/** Comparison form of a label: trimmed, whitespace collapsed, case-folded. */
export function normalizeLabel(text) {
  if (typeof text !== 'string') {
    throw new Error('--label <text> is required: a short, non-secret name for the Google account (an alias is fine)');
  }
  const clean = text.normalize('NFKC').trim().replace(/\s+/g, ' ');
  // \p{C}: control, format (zero-width, bidi), surrogate, private-use and unassigned characters
  if (!clean || clean.length > MAX_LABEL || /\p{C}/u.test(clean)) {
    throw new Error(`label must be 1-${MAX_LABEL} printable characters`);
  }
  return clean.toLowerCase();
}

export const displayLabel = (text) => text.normalize('NFC').trim().replace(/\s+/g, ' ');

function defaultIo() {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { return await rl.question(question); } finally { rl.close(); }
    }
  };
}

/** Ask which Google account was just signed in; blank answer means skip. */
export async function askLabel(io = defaultIo()) {
  return String(await io.ask('Email of the Google account you just signed in with (blank to skip): ')).trim();
}

/**
 * Validate the label and build the identity record. A label already attested on another
 * account is refused by accounts.preflightAttest before this runs. --confirm-unique-google-account
 * is still accepted and does nothing (old scripts keep working).
 */
export function requireAttestation(id, opts) {
  normalizeLabel(opts.label); // throws a clear message when missing or invalid
  return { label: displayLabel(String(opts.label)), attestedAt: new Date().toISOString(), method: 'manual' };
}

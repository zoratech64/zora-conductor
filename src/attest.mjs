import { createInterface } from 'node:readline/promises';

/**
 * Manual attestation that one Google account is registered in exactly one
 * profile. ZC cannot check this: agy has no identity command and ZC never
 * reads token files. The control is a recorded, enforced human assertion.
 */

export const ATTEST_PHRASE = 'one-google-account-per-profile';
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

export function attestationText(id, label) {
  return [
    `zc: you are registering profile "${id}" as Google account "${label}".`,
    'This claim cannot be verified: agy has no way to report which Google account a profile uses,',
    'and ZC never reads token files. If the same Google account is also used in another profile,',
    'both profiles share one quota and the one-lease-per-account protection no longer holds.',
    `Confirm only if this Google account is registered in no other profile. To confirm, type: ${ATTEST_PHRASE}`
  ].join('\n');
}

function defaultIo() {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    print: (text) => process.stderr.write(`${text}\n`),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { return await rl.question(question); } finally { rl.close(); }
    }
  };
}

/**
 * Demand a label plus an explicit confirmation: the typed phrase on a terminal,
 * or --confirm-unique-google-account without one. Returns the identity record.
 */
export async function requireAttestation(id, opts, io = defaultIo()) {
  const label = displayLabel(String(opts.label ?? ''));
  normalizeLabel(opts.label); // throws a clear message when missing or invalid
  io.print?.(attestationText(id, label));
  if (opts['confirm-unique-google-account'] === true) {
    return { label, attestedAt: new Date().toISOString(), method: 'manual' };
  }
  if (!io.isTTY) {
    throw new Error('no terminal to confirm on: pass --confirm-unique-google-account together with --label');
  }
  const typed = String(await io.ask(`type ${ATTEST_PHRASE}: `)).trim();
  if (typed !== ATTEST_PHRASE) throw new Error(`confirmation phrase did not match; nothing was changed`);
  return { label, attestedAt: new Date().toISOString(), method: 'manual' };
}

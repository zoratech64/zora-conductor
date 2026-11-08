import { readJson, writeJsonAtomic } from './fsx.mjs';
import { accountsFile, profileDirFor } from './paths.mjs';

const ID = /^[a-z0-9][a-z0-9_-]{0,30}$/i;

const load = () => readJson(accountsFile(), { currentId: null, accounts: {} });
const save = (state) => writeJsonAtomic(accountsFile(), state);

export const listAccounts = () => Object.values(load().accounts).sort((a, b) => a.id.localeCompare(b.id));
export const getAccount = (id) => load().accounts[id] ?? null;
export const currentId = () => load().currentId;

export function addAccount(id, { adapter = 'agy', dir } = {}) {
  if (!ID.test(id)) throw new Error(`account id "${id}" must be letters, digits, - or _ (max 31 chars)`);
  const state = load();
  if (state.accounts[id]) throw new Error(`account "${id}" already exists`);
  state.accounts[id] = {
    id,
    adapter,
    profileDir: dir ?? profileDirFor(id),
    status: 'needs-login',
    createdAt: new Date().toISOString(),
    lastUsedAt: 0,
    cooldownUntil: 0,
    holdReason: null,
    usage: null
  };
  save(state);
  return state.accounts[id];
}

export function updateAccount(id, patch) {
  const state = load();
  if (!state.accounts[id]) throw new Error(`unknown account "${id}"`);
  Object.assign(state.accounts[id], patch);
  save(state);
  return state.accounts[id];
}

export function removeAccount(id) {
  const state = load();
  if (!state.accounts[id]) throw new Error(`unknown account "${id}"`);
  delete state.accounts[id];
  if (state.currentId === id) state.currentId = null;
  save(state);
}

export const isEligible = (account, now = Date.now()) =>
  account.status === 'ready' && (account.cooldownUntil || 0) <= now;

/**
 * Sticky selection: keep using the current account until it is exhausted, then
 * fall back to the least recently used eligible one.
 */
export function pickNext({ now = Date.now(), exclude = [] } = {}) {
  const state = load();
  const eligible = Object.values(state.accounts).filter((a) => isEligible(a, now) && !exclude.includes(a.id));
  if (!eligible.length) return null;
  const current = eligible.find((a) => a.id === state.currentId);
  if (current) return current;
  return eligible.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0) || a.id.localeCompare(b.id))[0];
}

export function markUsed(id) {
  const state = load();
  if (!state.accounts[id]) return;
  state.currentId = id;
  state.accounts[id].lastUsedAt = Date.now();
  save(state);
}

function hold(id, patch) {
  const state = load();
  if (!state.accounts[id]) return;
  Object.assign(state.accounts[id], patch);
  if (state.currentId === id) state.currentId = null;
  save(state);
}

export const cooldown = (id, untilMs, reason) => hold(id, { cooldownUntil: untilMs, holdReason: reason });
export const setStatus = (id, status, reason = null) => hold(id, { status, holdReason: reason });

/** Operator override: clear cooldown/block after verifying the account is fine. */
export function resetAccount(id) {
  updateAccount(id, { status: 'ready', cooldownUntil: 0, holdReason: null });
}

/** Earliest time any logged-in account becomes usable again, as epoch ms (or null). */
export function nextAvailableAt(now = Date.now()) {
  const times = listAccounts()
    .filter((a) => a.status === 'ready' && (a.cooldownUntil || 0) > now)
    .map((a) => a.cooldownUntil);
  return times.length ? Math.min(...times) : null;
}

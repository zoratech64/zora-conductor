import { checkFlags, flagsBaseline } from './gitmeta-flags.mjs';
import { checkMetaInert } from './gitmeta-inert.mjs';
import { checkIdentity, restoreIdentity } from './gitmeta-layout.mjs';
import { checkMetaFiles } from './gitmeta-restore.mjs';
import { metaBaseline } from './gitmeta-baseline.mjs';

/** Everything the gate compares against, recorded before the worker starts. Throws when it cannot be recorded safely. */
export function takeMetaBaseline(root, layout) {
  return { meta: metaBaseline(root, layout), flags: flagsBaseline(root) };
}

/**
 * The git metadata integrity gate (spec 11.5). Order matters: identity first (filesystem only), then
 * filesystem comparisons and private restores, then inert git comparisons, then index flags. Each step
 * only runs when everything before it was repaired, so no git command runs against metadata that was not.
 * Returns entries { area, path, change, restorable, restored, detail }; an empty array means nothing changed.
 * An entry with restored === false needs a human.
 */
export function runGate(root, layout, base, { saveDir }) {
  const entries = [];
  const stop = () => entries.some((e) => !e.restored);

  const identity = checkIdentity(root, layout);
  if (identity.length) {
    restoreIdentity(root, layout, identity, { saveDir });
    entries.push(...identity);
    if (stop()) return entries;
  }
  entries.push(...checkMetaFiles(root, layout, base.meta, { saveDir }));
  if (stop()) return entries;
  entries.push(...checkMetaInert(root, layout, base.meta));
  if (stop()) return entries;
  entries.push(...checkFlags(root, base.flags, { saveDir }));
  return entries;
}

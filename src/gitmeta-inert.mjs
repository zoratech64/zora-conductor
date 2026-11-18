import * as G from './gitx.mjs';
import { toReportPath } from './gitmeta-layout.mjs';
import { effectiveConfigText, parseConfigList, refsListing } from './gitmeta-baseline.mjs';

export function checkMetaInert(root, layout, baseline) {
  const entries = [];
  try {
    const configOut = G.configList(root);
    const configRows = parseConfigList(configOut);
    const currentEffective = effectiveConfigText(configRows);

    if (currentEffective !== baseline.effective) {
      const baseLines = baseline.effective ? baseline.effective.split('\n') : [];
      const currLines = currentEffective ? currentEffective.split('\n') : [];

      const added = [];
      const baseRem = new Map();
      for (const l of baseLines) {
        baseRem.set(l, (baseRem.get(l) || 0) + 1);
      }
      for (const l of currLines) {
        const count = baseRem.get(l) || 0;
        if (count > 0) {
          baseRem.set(l, count - 1);
        } else {
          added.push(l);
        }
      }

      const removed = [];
      const currRem = new Map();
      for (const l of currLines) {
        currRem.set(l, (currRem.get(l) || 0) + 1);
      }
      for (const l of baseLines) {
        const count = currRem.get(l) || 0;
        if (count > 0) {
          currRem.set(l, count - 1);
        } else {
          removed.push(l);
        }
      }

      const detailParts = [];
      if (added.length > 0) {
        detailParts.push(`added:\n${added.slice(0, 20).join('\n')}`);
      }
      if (removed.length > 0) {
        detailParts.push(`removed:\n${removed.slice(0, 20).join('\n')}`);
      }
      const detail = detailParts.join('\n');

      entries.push({
        area: 'config-effective',
        path: toReportPath(root, baseline.paths.config),
        change: 'modified',
        restorable: false,
        restored: false,
        detail
      });
    }

    const currentRefs = refsListing(root);
    const allRefNames = new Set([...baseline.refs.keys(), ...currentRefs.keys()]);
    const sortedRefNames = [...allRefNames].sort();

    for (const refname of sortedRefNames) {
      const oldObj = baseline.refs.get(refname);
      const newObj = currentRefs.get(refname);

      if (oldObj === undefined && newObj !== undefined) {
        entries.push({
          area: 'refs',
          path: refname,
          change: 'added',
          restorable: false,
          restored: false,
          detail: `(none) -> ${newObj}`
        });
      } else if (oldObj !== undefined && newObj === undefined) {
        entries.push({
          area: 'refs',
          path: refname,
          change: 'removed',
          restorable: false,
          restored: false,
          detail: `${oldObj} -> (none)`
        });
      } else if (oldObj !== newObj) {
        entries.push({
          area: 'refs',
          path: refname,
          change: 'modified',
          restorable: false,
          restored: false,
          detail: `${oldObj} -> ${newObj}`
        });
      }
    }
  } catch (err) {
    return [{
      area: 'git',
      path: '.git',
      change: 'unreadable',
      restorable: false,
      restored: false,
      detail: err?.message ?? String(err)
    }];
  }

  return entries;
}

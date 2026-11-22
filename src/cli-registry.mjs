import { parseArgs } from './args.mjs';
import { activate, barrierState, downgrade, readAccountsState } from './migrate.mjs';
import { registryDir } from './registry-path.mjs';
import { stateRoot } from './paths.mjs';

function printReport(report, action) {
  for (const step of report.steps) console.log(`zc: ${step}`);
  for (const warning of report.warnings) console.log(`zc: warning: ${warning}`);
  if (report.refused.length) throw new Error(`${action} refused: ${report.refused.join('; ')}`);
  if (report.applied) console.log(`zc: ${action} done`);
}

function printStatus() {
  const { state, detail } = barrierState();
  console.log(`zc: state root      ${stateRoot()}`);
  console.log(`zc: registry        ${registryDir()}`);
  console.log(`zc: accounts store  ${state} (${detail})`);
  if (state === 'legacy' || state === 'active') console.log(`zc: accounts        ${Object.keys(readAccountsState().data.accounts).length}`);
}

/** zc registry status | activate [--apply] | downgrade [--apply] */
export async function cmdRegistry(argv) {
  const [sub, ...rest] = argv;
  const opts = parseArgs(rest, { bool: ['apply'] });
  switch (sub) {
    case 'status': return printStatus();
    case 'activate': return printReport(activate({ apply: opts.apply === true }), 'activate');
    case 'downgrade': return printReport(downgrade({ apply: opts.apply === true }), 'downgrade');
    default: throw new Error('usage: zc registry status|activate [--apply]|downgrade [--apply]');
  }
}

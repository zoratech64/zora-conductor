// Child for test/concurrency.test.mjs: 40 mutations against the shared accounts store.
import * as accounts from '../src/accounts.mjs';

const [tag, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
  accounts.addAccount(`p${tag}-${i}`);
  accounts.updateAccount(`p${tag}-0`, { lastUsedAt: 1000 + i });
}

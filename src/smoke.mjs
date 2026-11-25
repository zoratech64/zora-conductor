/**
 * `zc smoke`: one read-only call (`agy -p /usage`, no model, no tokens) per registered worker.
 * A worker passes only when it answers in time, is signed in and its output parses; it never
 * changes account state, and one worker's failure never stops the next.
 */
const reason = (r, timeoutMs) => {
  if (r.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (r.authFailed) return 'not signed in';
  if (r.error) return r.error;
  if (!r.ok) return r.text || 'agy exited with an error';
  if (!r.limits.length) return 'no usage data in the response';
  return null;
};

export async function smokeAll({ accounts, check, lease, timeoutMs }) {
  const results = [];
  for (const account of accounts) {
    const started = Date.now();
    let failure;
    try {
      const r = await lease(account, 'smoke', () => check(account, { timeoutMs }));
      failure = reason(r, timeoutMs);
    } catch (error) { failure = error.message; }
    results.push({ id: account.id, ok: failure === null, ms: Date.now() - started, ...(failure === null ? {} : { error: String(failure).replace(/\s+/g, ' ').slice(0, 200) }) });
  }
  const passed = results.filter((r) => r.ok).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

export function formatSmoke({ total, passed, failed, results }) {
  if (!total) return 'zc: smoke FAIL: no workers registered (add one with `zc account add <id>`)';
  const lines = results.map((r) => `${r.ok ? 'OK  ' : 'FAIL'} ${r.id} (${r.ms}ms)${r.ok ? '' : ` - ${r.error}`}`);
  return [...lines, `smoke: total ${total}, passed ${passed}, failed ${failed}`].join('\n');
}

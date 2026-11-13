import { Buffer } from 'node:buffer';

/**
 * Digest worker execution metrics from parsed agy output and the prompt sent to it.
 * Pure function: never mutates arguments, never throws on missing/empty fields.
 */
export function attemptMetrics(parsed, prompt) {
  const promptBytes = Buffer.byteLength(prompt ?? '', 'utf8');
  const turns = parsed?.status ? (parsed.turns ?? null) : null;
  const usage = parsed?.usage && typeof parsed.usage === 'object' ? { ...parsed.usage } : null;

  const rawTools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  let failed = 0;
  const byName = {};
  let read = 0;
  let edit = 0;
  let write = 0;

  for (const t of rawTools) {
    if (t?.failed === true) {
      failed += 1;
    }
    const name = t?.name;
    if (name) {
      byName[name] = (byName[name] ?? 0) + 1;
      if (name === 'read_file') {
        read += 1;
      } else if (name === 'edit_file') {
        edit += 1;
      } else if (name === 'write_file' || name === 'write_to_file') {
        write += 1;
      }
    }
  }

  return {
    promptBytes,
    turns,
    usage,
    tools: {
      total: rawTools.length,
      failed,
      byName
    },
    fileOps: {
      read,
      edit,
      write
    }
  };
}

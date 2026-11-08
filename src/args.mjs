/**
 * Tiny argv parser. spec.bool: flags without a value; spec.multi: repeatable
 * flags collected into arrays. Everything else is `--key value` or `--key=value`.
 */
export function parseArgs(argv, spec = {}) {
  const bool = new Set(spec.bool ?? []);
  const multi = new Set(spec.multi ?? []);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    let [key, value] = arg.slice(2).split(/=(.*)/s, 2);
    if (bool.has(key)) {
      out[key] = value === undefined ? true : value !== 'false';
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new Error(`--${key} needs a value`);
    }
    if (multi.has(key)) (out[key] ??= []).push(value);
    else out[key] = value;
  }
  return out;
}

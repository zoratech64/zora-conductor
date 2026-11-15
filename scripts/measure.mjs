import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../src/args.mjs';
import { loadConfig } from '../src/config.mjs';
import { dispatch } from '../src/dispatch.mjs';
import { head } from '../src/gitx.mjs';
import { runsDir, stateRoot } from '../src/paths.mjs';
import { loadEccAssets, selectEccRules } from '../src/prompt.mjs';
import { parseTask } from '../src/task.mjs';

const USAGE = [
  'usage: node scripts/measure.mjs prompt [--project <dir>] [--packs <a,b>] <task.md>...',
  '       node scripts/measure.mjs runs [--project <dir>] [--all-projects] [--split <ISO date>]',
  '       node scripts/measure.mjs compare [--key <name>] <pre.json> <post.json>'
].join('\n');

const RUN_REPORT_NOTES = [
  'promptBytes is prompt size, not token usage.',
  'worker*Tokens are Gemini worker usage reported by agy; they say nothing about Claude (manager) token use.',
  'missing counts entries without that field; they are never counted as zero.'
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function calcMetricStats(numbers, missingCount) {
  const n = numbers.length;
  if (n === 0) {
    return {
      n: 0,
      missing: missingCount,
      median: null,
      mean: null,
      min: null,
      max: null
    };
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = numbers.reduce((acc, v) => acc + v, 0);
  const rawMean = Math.round((sum / n) * 10) / 10;
  const mean = rawMean === 0 ? 0 : rawMean;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n, missing: missingCount, median, mean, min, max };
}

function parsePacks(packs) {
  if (packs === undefined) return undefined;
  if (Array.isArray(packs)) return packs;
  return String(packs).split(',').map((p) => p.trim()).filter(Boolean);
}

export async function measurePrompts({ root, files = [], packs } = {}) {
  const projectRoot = resolve(root ?? process.cwd());
  if (!Array.isArray(files) || !files.length) {
    throw new Error('at least one task file required');
  }

  let commit = null;
  try {
    commit = head(projectRoot);
  } catch {
    commit = null;
  }

  const tasks = [];
  let finalConfig = null;

  for (const file of files) {
    const baseConfig = loadConfig(projectRoot);
    const overriddenPacks = parsePacks(packs);
    const config = {
      ...baseConfig,
      ecc: {
        ...baseConfig.ecc,
        rulePacks: overriddenPacks !== undefined ? overriddenPacks : baseConfig.ecc.rulePacks
      }
    };
    finalConfig = config;

    const filePath = existsSync(resolve(projectRoot, file))
      ? resolve(projectRoot, file)
      : resolve(file);

    const text = readFileSync(filePath, 'utf8');
    const task = parseTask(text, { fallbackId: basename(file).replace(/\.\w+$/, '') });

    const { prompt } = await dispatch({ root: projectRoot, task, config, dryRun: true });
    const { text: eccRules, omitted } = selectEccRules(config);
    const eccAssets = loadEccAssets(config, task);

    tasks.push({
      file,
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      promptChars: prompt.length,
      eccRulesChars: eccRules.length,
      eccAssetsChars: eccAssets.length,
      rulesTruncated: omitted.length > 0
    });
  }

  return {
    kind: 'prompt-size',
    generatedAt: new Date().toISOString(),
    commit,
    node: process.version,
    rulePacks: finalConfig.ecc.rulePacks,
    maxChars: finalConfig.ecc.maxChars,
    tasks
  };
}

function collectRunRecords(dirs) {
  const unreadable = [];
  const runs = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      unreadable.push({ path: dir, error: error.message });
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const resultPath = join(dir, entry.name, 'result.json');
      try {
        const text = readFileSync(resultPath, 'utf8');
        let data;
        try {
          data = JSON.parse(text);
        } catch (parseError) {
          unreadable.push({ path: resultPath, error: parseError.message });
          continue;
        }
        if (!isPlainObject(data) || typeof data.runId !== 'string') {
          unreadable.push({ path: resultPath, error: 'not a plain object with string runId' });
          continue;
        }
        runs.push(data);
      } catch (readError) {
        unreadable.push({ path: resultPath, error: readError.message });
      }
    }
  }

  return { runs, unreadable };
}

function summarizeGroup(runs) {
  const statuses = {};
  let repairRuns = 0;
  let attempts = 0;

  const pBytes = []; let pBytesMiss = 0;
  const turns = []; let turnsMiss = 0;
  const tTotal = []; let tTotalMiss = 0;
  const tFailed = []; let tFailedMiss = 0;
  const inTok = []; let inTokMiss = 0;
  const outTok = []; let outTokMiss = 0;
  const totTok = []; let totTokMiss = 0;
  const attDur = []; let attDurMiss = 0;
  const attPerRun = []; let attPerRunMiss = 0;
  const verDur = []; let verDurMiss = 0;

  for (const r of runs) {
    if (typeof r.status === 'string') {
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    } else if (r.status != null) {
      const s = String(r.status);
      statuses[s] = (statuses[s] ?? 0) + 1;
    }

    if (r.repairOf != null && r.repairOf !== '') {
      repairRuns += 1;
    }

    if (Array.isArray(r.attempts)) {
      attempts += r.attempts.length;
      attPerRun.push(r.attempts.length);
      for (const att of r.attempts) {
        const pb = att?.metrics?.promptBytes;
        if (isFiniteNumber(pb)) pBytes.push(pb); else pBytesMiss += 1;

        const tu = att?.metrics?.turns;
        if (isFiniteNumber(tu)) turns.push(tu); else turnsMiss += 1;

        const tt = att?.metrics?.tools?.total;
        if (isFiniteNumber(tt)) tTotal.push(tt); else tTotalMiss += 1;

        const tf = att?.metrics?.tools?.failed;
        if (isFiniteNumber(tf)) tFailed.push(tf); else tFailedMiss += 1;

        const ui = att?.metrics?.usage?.input_tokens;
        if (isFiniteNumber(ui)) inTok.push(ui); else inTokMiss += 1;

        const uo = att?.metrics?.usage?.output_tokens;
        if (isFiniteNumber(uo)) outTok.push(uo); else outTokMiss += 1;

        const ut = att?.metrics?.usage?.total_tokens;
        if (isFiniteNumber(ut)) totTok.push(ut); else totTokMiss += 1;

        const ad = att?.durationMs;
        if (isFiniteNumber(ad)) attDur.push(ad); else attDurMiss += 1;
      }
    } else {
      attPerRunMiss += 1;
    }

    const vd = r.verifyDurationMs;
    if (isFiniteNumber(vd)) verDur.push(vd); else verDurMiss += 1;
  }

  return {
    runs: runs.length,
    statuses,
    repairRuns,
    attempts,
    metrics: {
      promptBytes: calcMetricStats(pBytes, pBytesMiss),
      turns: calcMetricStats(turns, turnsMiss),
      toolsTotal: calcMetricStats(tTotal, tTotalMiss),
      toolsFailed: calcMetricStats(tFailed, tFailedMiss),
      workerInputTokens: calcMetricStats(inTok, inTokMiss),
      workerOutputTokens: calcMetricStats(outTok, outTokMiss),
      workerTotalTokens: calcMetricStats(totTok, totTokMiss),
      attemptDurationMs: calcMetricStats(attDur, attDurMiss),
      attemptsPerRun: calcMetricStats(attPerRun, attPerRunMiss),
      verifyDurationMs: calcMetricStats(verDur, verDurMiss)
    }
  };
}

export function reportRuns({ dirs, split } = {}) {
  const targetDirs = Array.isArray(dirs)
    ? dirs
    : (dirs ? [dirs] : [runsDir(process.cwd())]);

  let splitMs = null;
  if (split !== undefined && split !== null) {
    if (typeof split !== 'string' || !split.trim()) {
      throw new Error(`invalid split date: "${split}"`);
    }
    splitMs = Date.parse(split);
    if (Number.isNaN(splitMs)) {
      throw new Error(`invalid split date: "${split}"`);
    }
  }

  const { runs, unreadable } = collectRunRecords(targetDirs);

  let groups;
  if (splitMs === null) {
    groups = {
      all: summarizeGroup(runs)
    };
  } else {
    const beforeRuns = [];
    const afterRuns = [];
    const undatedRuns = [];

    for (const r of runs) {
      const startedAtMs = typeof r.startedAt === 'string' ? Date.parse(r.startedAt) : NaN;
      if (Number.isNaN(startedAtMs)) {
        undatedRuns.push(r);
      } else if (startedAtMs < splitMs) {
        beforeRuns.push(r);
      } else {
        afterRuns.push(r);
      }
    }

    groups = {
      before: summarizeGroup(beforeRuns),
      after: summarizeGroup(afterRuns),
      undated: summarizeGroup(undatedRuns)
    };
  }

  return {
    kind: 'run-report',
    generatedAt: new Date().toISOString(),
    dirs: targetDirs,
    split: split ?? null,
    unreadable,
    groups,
    notes: RUN_REPORT_NOTES
  };
}

export function selectPromptSection(doc, key, label) {
  if (key === undefined) {
    return doc;
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('--key needs a value');
  }
  if (!isPlainObject(doc) || !Object.hasOwn(doc, key)) {
    throw new Error(`${label} has no "${key}" section`);
  }
  return doc[key];
}

export function comparePromptSizes(pre, post) {
  if (pre?.kind !== 'prompt-size' || post?.kind !== 'prompt-size') {
    throw new Error('both arguments must have kind: "prompt-size"');
  }

  const packsDiffer = !arraysEqual(pre.rulePacks, post.rulePacks);
  const maxCharsDiffer = pre.maxChars !== post.maxChars;

  if (packsDiffer || maxCharsDiffer) {
    let reason;
    if (packsDiffer && maxCharsDiffer) {
      reason = 'rulePacks and maxChars differ';
    } else if (packsDiffer) {
      reason = 'rulePacks differ';
    } else {
      reason = 'maxChars differ';
    }
    return {
      kind: 'prompt-compare',
      comparable: false,
      reason,
      tasks: []
    };
  }

  const preTasks = Array.isArray(pre.tasks) ? pre.tasks : [];
  const postTasks = Array.isArray(post.tasks) ? post.tasks : [];

  const preByFile = new Map();
  for (const t of preTasks) {
    if (t && typeof t.file === 'string') {
      preByFile.set(t.file, t);
    }
  }

  const postByFile = new Map();
  for (const t of postTasks) {
    if (t && typeof t.file === 'string') {
      postByFile.set(t.file, t);
    }
  }

  const tasks = [];
  const unpaired = [];

  for (const preTask of preTasks) {
    if (!preTask || typeof preTask.file !== 'string') continue;
    const file = preTask.file;
    if (postByFile.has(file)) {
      const postTask = postByFile.get(file);
      const preBytes = typeof preTask.promptBytes === 'number' ? preTask.promptBytes : 0;
      const postBytes = typeof postTask.promptBytes === 'number' ? postTask.promptBytes : 0;
      const deltaBytes = postBytes - preBytes;
      let deltaPct = 0;
      if (preBytes !== 0) {
        const rawPct = (deltaBytes / preBytes) * 100;
        deltaPct = Math.round(rawPct * 10) / 10;
        if (deltaPct === 0) deltaPct = 0;
      }
      tasks.push({
        file,
        preBytes,
        postBytes,
        deltaBytes,
        deltaPct,
        preRulesChars: typeof preTask.eccRulesChars === 'number' ? preTask.eccRulesChars : 0,
        postRulesChars: typeof postTask.eccRulesChars === 'number' ? postTask.eccRulesChars : 0
      });
    } else {
      unpaired.push(file);
    }
  }

  for (const postTask of postTasks) {
    if (!postTask || typeof postTask.file !== 'string') continue;
    const file = postTask.file;
    if (!preByFile.has(file)) {
      unpaired.push(file);
    }
  }

  return {
    kind: 'prompt-compare',
    comparable: true,
    pre: {
      commit: pre.commit ?? null,
      generatedAt: pre.generatedAt ?? null
    },
    post: {
      commit: post.commit ?? null,
      generatedAt: post.generatedAt ?? null
    },
    tasks,
    unpaired
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === 'prompt') {
    let opts;
    try {
      opts = parseArgs(rest);
    } catch (error) {
      console.error(`measure: ${error.message}`);
      process.exit(1);
    }

    if (!opts._.length) {
      console.error('measure: at least one task file required');
      process.exit(1);
    }

    try {
      const result = await measurePrompts({
        root: opts.project,
        files: opts._,
        packs: opts.packs
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`measure: ${error.message}`);
      process.exit(1);
    }
  } else if (subcommand === 'runs') {
    let opts;
    try {
      opts = parseArgs(rest, { bool: ['all-projects'] });
    } catch (error) {
      console.error(`measure: ${error.message}`);
      process.exit(1);
    }

    try {
      let dirs;
      if (opts['all-projects']) {
        const projectsBase = join(stateRoot(), 'projects');
        dirs = [];
        if (existsSync(projectsBase)) {
          try {
            dirs = readdirSync(projectsBase, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => join(projectsBase, d.name, 'runs'));
          } catch {
            dirs = [];
          }
        }
      } else {
        const root = opts.project ?? process.cwd();
        dirs = [runsDir(root)];
      }

      const result = reportRuns({ dirs, split: opts.split });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`measure: ${error.message}`);
      process.exit(1);
    }
  } else if (subcommand === 'compare') {
    let opts;
    try {
      opts = parseArgs(rest);
    } catch (error) {
      console.error(`measure: ${error.message}`);
      process.exit(1);
    }

    const [prePath, postPath] = opts._;
    if (!prePath || !postPath || opts._.length !== 2) {
      console.error('measure: compare requires two files: <pre.json> <post.json>');
      process.exit(1);
    }

    function findPromptSections(pre, post) {
      const sections = [];
      if (isPlainObject(pre)) {
        for (const [k, v] of Object.entries(pre)) {
          if (isPlainObject(v) && v.kind === 'prompt-size') {
            sections.push(k);
          }
        }
      }
      if (isPlainObject(post)) {
        for (const [k, v] of Object.entries(post)) {
          if (isPlainObject(v) && v.kind === 'prompt-size' && !sections.includes(k)) {
            sections.push(k);
          }
        }
      }
      return sections;
    }

    try {
      const preText = readFileSync(resolve(prePath), 'utf8');
      const postText = readFileSync(resolve(postPath), 'utf8');
      const pre = selectPromptSection(JSON.parse(preText), opts.key, prePath);
      const post = selectPromptSection(JSON.parse(postText), opts.key, postPath);
      let result;
      try {
        result = comparePromptSizes(pre, post);
      } catch (error) {
        if (opts.key === undefined) {
          const sections = findPromptSections(pre, post);
          if (sections.length > 0) {
            console.error(
              `measure: ${error.message}; these files hold prompt-size sections, use --key <name>: ${sections.join(', ')}`
            );
            process.exit(1);
          }
        }
        throw error;
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`measure: ${error.message}`);
      process.exit(1);
    }
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb } from '../libs/knex.js';
import candidates from '../repositories/cpvCandidate.repo.js';
import classifier from '../repositories/cpvClassifier.repo.js';
import { nearest, NEAREST_FLOOR } from '../services/cpvInference.service.js';
import CpvModelService, { subjectOf } from '../services/cpvModel.service.js';
import config from '../configs/variables.config.js';
import { PURCHASE_KINDS, PURCHASE_KIND_CODES } from '../libs/purchaseKinds.js';

/**
 * Would an inferred CPV code agree with the code the buyer stated?
 *
 * A backtest against lots whose source states a code (cpv-inference tickets 02
 * and 03, ADR 0006). Both methods run on the same held-out lots: `nearest`
 * (no model) over a sweep of similarity floors, and `model` (a cheap model
 * picks among the candidates, judged in code) over a sweep of confidence
 * thresholds — the model is asked once per lot and the sweep is read off its
 * answers. The model run's cost is printed: tokens, cache reads, dollars. Hold a sample out, gather each one's candidates as if it had no
 * code — its own tender and the tenders of its reference code excluded, so a
 * lot is never graded on a sibling's copy of its own code — choose a code, and
 * compare it with the stated one at the full code, the first 5 digits, the
 * first 3 and the division. A lot answered none is reported as coverage, never
 * as wrong: an uncoded lot sends no wrong alert.
 *
 * It calls the production candidate search and the production `nearest`
 * unchanged — a second copy of the rule would measure something not shipped.
 * Reported per purchase kind, because paper buys works and services more than
 * e-auction does, and a high score on goods must not hide a poor one there.
 *
 * Who is sampled (spec, *Backtest*): goods from e-auction and ARMEPS; works
 * and services from ARMEPS's labelled lots, plus any hand-labelled paper lots.
 * e-auction's works and services are printed beside them, outside the kind's
 * total. When ARMEPS gives fewer than --min-kind distinct lots of a kind and
 * no labelled file exists yet, a file of paper lots is written for the owner
 * to label; once labelled, the next run includes it.
 *
 * Also printed, floor-free: how often the stated code (or its division) was
 * among the candidates at all — the ceiling any method choosing among them can
 * reach, the model included.
 *
 * Run by hand; prints numbers; asserts nothing. Not a test.
 *
 * Usage:
 *   node src/scripts/backtestCpvInference.js [--per-kind=300] [--floors=0.3,0.4,0.5,0.6,0.7,0.8]
 *     [--seed=cpv] [--min-kind=50] [--labelled=.scratch/cpv-inference/paper-lots.csv]
 *     [--methods=nearest,model] [--confidences=0,0.5,0.6,0.7,0.8,0.9] [--outline=on|off] [--dump=answers.jsonl]
 *
 *   --per-kind   distinct lots held out per kind and channel, at most
 *   --floors     `nearest` similarity floors to sweep (production: NEAREST_FLOOR)
 *   --seed       orders the draw; the same seed draws the same lots
 *   --min-kind   below this many ARMEPS lots, a kind asks for hand labels
 *   --labelled   the paper-lot file: read when present, written when needed and absent
 *   --methods    which methods to run; `model` calls AI.CPV_MODEL once per held-out lot
 *   --confidences  `model` confidence thresholds to sweep (production: AI.CPV_MIN_CONFIDENCE)
 *   --outline    the model's system prompt with or without the classifier outline (default: production's)
 *   --dump       write one JSON line per held-out lot (truth, both answers, the model's reason)
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.length ? rest.join('=') : true];
  })
);

const perKind = Number(args['per-kind'] ?? 300);
const floors = String(args.floors ?? '0.3,0.4,0.5,0.6,0.7,0.8').split(',').map(Number).filter((n) => n >= 0 && n <= 1);
const seed = String(args.seed ?? 'cpv');
const minKind = Number(args['min-kind'] ?? 50);
const methods = String(args.methods ?? 'nearest,model').split(',').map((m) => m.trim());
const confidences = String(args.confidences ?? '0,0.5,0.6,0.7,0.8,0.9')
  .split(',')
  .map(Number)
  .filter((n) => n >= 0 && n <= 1);
const dumpPath = args.dump && args.dump !== true ? String(args.dump) : null;
/** Whether the model's system prompt carries the classifier outline: on, off, or the production default. */
const outlineArg = args.outline === 'on' ? true : args.outline === 'off' ? false : undefined;
const labelledPath =
  args.labelled && args.labelled !== true
    ? String(args.labelled)
    : fileURLToPath(new URL('../../.scratch/cpv-inference/paper-lots.csv', import.meta.url));

/** How many paper lots a label file asks for, per short kind. */
const TO_LABEL = 50;
/** The word a lot or its tender uses for each kind that is not goods. */
const KIND_WORDS = { works: 'աշխատանք', services: 'ծառայություն' };
const CONCURRENCY = 4;
const { AI } = config;

/**
 * List prices of `claude-haiku-5-5` in dollars per million tokens (2026-11,
 * prompts up to 100K tokens): input, a 5-minute cache write (1.25×), a cache
 * read (0.1×), output. A gateway's own figure (OpenRouter's `usage.cost`) is
 * printed beside it.
 */
const PRICE = { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 };

const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '—');

// ---- the label file: minimal CSV, quoted where needed ----

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header = [], ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
};

/** The hand-labelled paper lots, as held-out items; rows with no code are skipped and counted. */
const readLabelled = async () => {
  if (!fs.existsSync(labelledPath)) return { exists: false, items: [], notes: [] };
  const rows = parseCsv(fs.readFileSync(labelledPath, 'utf8'));
  const notes = [];
  const wanted = rows.filter((r) => r.code);
  const unlabelled = rows.length - wanted.length;
  if (unlabelled) notes.push(`${unlabelled} of ${rows.length} rows have no code yet`);

  const names = await classifier.namesFor(wanted.map((r) => r.code));
  const lots = new Map((await candidates.lotsByIds(wanted.map((r) => r.lot_id))).map((l) => [l.id, l]));
  const items = [];
  for (const r of wanted) {
    if (!PURCHASE_KIND_CODES.includes(r.kind)) notes.push(`${r.lot_id}: kind "${r.kind}" is not goods, works or services`);
    else if (!/^[0-9]{8}$/.test(r.code) || !names.has(r.code)) notes.push(`${r.lot_id}: ${r.code} is not in the classifier`);
    else if (!lots.has(r.lot_id)) notes.push(`${r.lot_id}: no such lot`);
    else {
      const lot = lots.get(r.lot_id);
      items.push({ ...lot, cpv_code: r.code, kind: r.kind, group: 'paper (labelled)' });
    }
  }
  return { exists: true, items, notes };
};

const writeToLabel = async (shortKinds) => {
  const picked = [];
  for (const kind of shortKinds) {
    const rows = await candidates.paperLotsToLabel({
      word: KIND_WORDS[kind],
      limit: TO_LABEL,
      excludeIds: picked.map((p) => p.id),
    });
    picked.push(...rows.map((r) => ({ ...r, guess: r.has_word ? kind : '' })));
  }
  const lines = ['lot_id,kind,code,name,subject'];
  for (const p of picked) {
    const subject = [p.title, p.description].filter(Boolean).join(' — ');
    lines.push([p.id, p.guess, '', p.name, subject].map(csvCell).join(','));
  }
  fs.mkdirSync(path.dirname(labelledPath), { recursive: true });
  fs.writeFileSync(labelledPath, `${lines.join('\n')}\n`);
  return picked.length;
};

// ---- the run ----

/** Map with a bounded number of promises in flight. */
const mapLimit = async (list, limit, fn) => {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
};

const agreeAt = (digits) => (a, b) => Boolean(a && b) && a.slice(0, digits) === b.slice(0, digits);
const LEVELS = [
  ['code', agreeAt(8)],
  ['5-digit', agreeAt(5)],
  ['3-digit', agreeAt(3)],
  ['division', agreeAt(2)],
];

const agreementLine = (answered) =>
  LEVELS.map(([name, agree]) => `${name} ${pct(answered.filter((r) => agree(r.guess, r.truth)).length, answered.length)}`).join(', ');

const report = (label, results, { tenders }) => {
  const n = results.length;
  if (!n) {
    console.log(`  ${label.padEnd(26)} no lots`);
    return;
  }
  const inCandidates = results.filter((r) => r.codes.includes(r.truth)).length;
  const divisionInCandidates = results.filter((r) => r.codes.some((c) => c.slice(0, 2) === r.truth.slice(0, 2))).length;
  console.log(
    `  ${label.padEnd(26)} ${String(n).padStart(4)} lots from ${String(tenders).padStart(4)} tenders | ` +
      `stated code among candidates ${pct(inCandidates, n)}, its division ${pct(divisionInCandidates, n)}`
  );
  if (methods.includes('nearest')) {
    for (const floor of floors) {
      const answered = results.map((r) => ({ truth: r.truth, guess: nearest(r.candidates, { floor }) })).filter((r) => r.guess);
      const mark = floor === NEAREST_FLOOR ? '*' : ' ';
      console.log(
        `    ${mark}nearest ≥ ${floor.toFixed(2)}  answered ${pct(answered.length, n).padStart(6)} (none ${pct(n - answered.length, n).padStart(6)}) | ` +
          `agree: ${agreementLine(answered)}`
      );
    }
  }
  if (methods.includes('model')) {
    for (const threshold of confidences) {
      const answered = results
        .filter((r) => r.model?.code && r.model.confidence >= threshold)
        .map((r) => ({ truth: r.truth, guess: r.model.code }));
      const mark = threshold === AI.CPV_MIN_CONFIDENCE ? '*' : ' ';
      console.log(
        `    ${mark}model ≥ ${threshold.toFixed(2)}    answered ${pct(answered.length, n).padStart(6)} (none ${pct(n - answered.length, n).padStart(6)}) | ` +
          `agree: ${agreementLine(answered)}`
      );
    }
    // Why the model wrote no code, at the production threshold.
    const why = new Map();
    for (const r of results) {
      const reason = !r.model
        ? 'not run'
        : r.model.code && r.model.confidence < AI.CPV_MIN_CONFIDENCE
          ? 'low_confidence'
          : r.model.reason;
      if (reason) why.set(reason, (why.get(reason) ?? 0) + 1);
    }
    const broader = results.filter((r) => r.model?.code && r.model.confidence >= AI.CPV_MIN_CONFIDENCE && r.model.broader).length;
    const parts = [...why.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`);
    console.log(`      model, no code: ${parts.join(', ') || '—'}; a broader code (not a candidate's own): ${broader}`);
  }
};

/**
 * The model's answer for one lot, asked at threshold 0: a pick below every
 * threshold is still the pick, and the report sweeps thresholds over it. A
 * failed call is counted as no code, with its error.
 */
const askModel = async (item, found) => {
  try {
    return await CpvModelService.choose({
      name: item.name,
      subject: subjectOf(item),
      candidates: found,
      minConfidence: 0,
      ...(outlineArg === undefined ? {} : { withOutline: outlineArg }),
    });
  } catch (error) {
    return { code: null, reason: `error:${error.code ?? error.name}`, confidence: null, usage: null };
  }
};

const run = async () => {
  if (methods.includes('model') && !AI.API_KEY) throw new Error('--methods includes model, but no ANTHROPIC_API_KEY is set');
  const groups = []; // { kind, label, inTotal, items }
  for (const kind of PURCHASE_KIND_CODES) {
    const kindLabel = PURCHASE_KINDS[kind];
    if (kind === 'goods') {
      for (const channel of ['armeps', 'eauction']) {
        const items = await candidates.labelledLots({ channels: [channel], kindLabel, limit: perKind, seed });
        groups.push({ kind, label: channel, inTotal: true, items });
      }
    } else {
      const armeps = await candidates.labelledLots({ channels: ['armeps'], kindLabel, limit: perKind, seed });
      const eauction = await candidates.labelledLots({ channels: ['eauction'], kindLabel, limit: perKind, seed });
      groups.push({ kind, label: 'armeps', inTotal: true, items: armeps });
      groups.push({ kind, label: 'eauction (outside total)', inTotal: false, items: eauction });
    }
  }

  // Kinds ARMEPS cannot measure alone ask for hand labels.
  const labelled = await readLabelled();
  for (const kind of PURCHASE_KIND_CODES) {
    const items = labelled.items.filter((i) => i.kind === kind);
    if (items.length) groups.push({ kind, label: 'paper (labelled)', inTotal: true, items });
  }
  const shortKinds = Object.keys(KIND_WORDS).filter((kind) => {
    const armeps = groups.find((g) => g.kind === kind && g.label === 'armeps').items.length;
    const paper = labelled.items.filter((i) => i.kind === kind).length;
    return armeps + paper < minKind;
  });

  const all = groups.flatMap((g) => g.items);
  console.log(
    `${all.length} held-out lots, seed "${seed}", ≤ ${perKind} per kind and channel; ` +
      `methods: ${methods.join(', ')}${outlineArg === undefined ? '' : `, outline ${outlineArg ? 'on' : 'off'}`}\n`
  );

  let done = 0;
  const results = new Map();
  const started = Date.now();
  await mapLimit(all, CONCURRENCY, async (item) => {
    const found = await candidates.candidatesFor({
      lotId: item.id,
      name: item.name,
      excludeTenderIds: item.exclude_tender_ids,
    });
    const model = methods.includes('model') ? await askModel(item, found) : null;
    if (model?.code) model.broader = !found.some((c) => c.code === model.code);
    results.set(item, {
      truth: item.cpv_code,
      candidates: found,
      codes: found.map((c) => c.code),
      tenderId: item.tender_id,
      model,
    });
    done++;
    if (done % 100 === 0) process.stderr.write(`  … ${done}/${all.length} (${Math.round((Date.now() - started) / 1000)} s)\n`);
  });

  for (const kind of PURCHASE_KIND_CODES) {
    const kindGroups = groups.filter((g) => g.kind === kind);
    console.log(`— ${kind} (${PURCHASE_KINDS[kind]}) —`);
    const total = kindGroups.filter((g) => g.inTotal).flatMap((g) => g.items.map((i) => results.get(i)));
    report('total', total, { tenders: new Set(total.map((r) => r.tenderId)).size });
    for (const g of kindGroups) {
      const rs = g.items.map((i) => results.get(i));
      report(g.label, rs, { tenders: new Set(rs.map((r) => r.tenderId)).size });
    }
    console.log('');
  }

  if (methods.includes('model')) {
    const answers = [...results.values()].map((r) => r.model).filter(Boolean);
    const sum = (key) => answers.reduce((total, a) => total + (a.usage?.[key] ?? 0), 0);
    const tokens = {
      input: sum('input_tokens'),
      cacheWrite: sum('cache_creation_input_tokens'),
      cacheRead: sum('cache_read_input_tokens'),
      output: sum('output_tokens'),
    };
    const listCost = Object.entries(tokens).reduce((total, [key, n]) => total + (n * PRICE[key]) / 1e6, 0);
    const gatewayCost = answers.some((a) => typeof a.usage?.cost === 'number') ? sum('cost') : null;
    const calls = answers.filter((a) => a.usage).length;
    const models = [...new Set(answers.map((a) => a.model).filter(Boolean))].join(', ');
    console.log(
      `model run: ${calls} calls to ${models || AI.CPV_MODEL} | tokens: input ${tokens.input}, cache write ${tokens.cacheWrite}, ` +
        `cache read ${tokens.cacheRead}, output ${tokens.output} | ` +
        `cost at list price $${listCost.toFixed(2)} ($${calls ? ((listCost / calls) * 1000).toFixed(2) : '—'} per 1,000 lots)` +
        (gatewayCost !== null ? `, as the gateway billed $${gatewayCost.toFixed(2)}` : '')
    );
    const errors = answers.filter((a) => a.reason?.startsWith('error:')).length;
    if (errors) console.log(`  ${errors} calls failed (counted as no code)`);
  }
  console.log(`production thresholds marked *: nearest ≥ ${NEAREST_FLOOR}, model ≥ ${AI.CPV_MIN_CONFIDENCE}\n`);

  if (dumpPath) {
    const lines = groups.flatMap((g) =>
      g.items.map((item) => {
        const r = results.get(item);
        return JSON.stringify({
          lot: item.id,
          kind: g.kind,
          group: g.label,
          name: item.name,
          truth: r.truth,
          nearest: nearest(r.candidates),
          model: r.model?.code ?? null,
          confidence: r.model?.confidence ?? null,
          reason: r.model?.reason ?? null,
          answered: r.model?.answered ?? null,
          explanation: r.model?.explanation ?? null,
        });
      })
    );
    fs.writeFileSync(dumpPath, `${lines.join('\n')}\n`);
    console.log(`answers written to ${dumpPath}`);
  }

  if (labelled.exists) {
    console.log(`labelled paper lots: ${labelledPath} — ${labelled.items.length} included`);
    for (const note of labelled.notes) console.log(`  ${note}`);
  }
  if (shortKinds.length) {
    if (labelled.exists) {
      console.log(`still fewer than ${minKind} lots for ${shortKinds.join(', ')} — label more rows in ${labelledPath}`);
    } else {
      const written = await writeToLabel(shortKinds);
      console.log(
        `fewer than ${minKind} ARMEPS lots for ${shortKinds.join(', ')}: wrote ${written} paper lots to label at ${labelledPath}\n` +
          '  fill `code` (8 digits, from the classifier) and correct `kind` (goods | works | services); the next run includes them'
      );
    }
  }
};

run()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(`[cpv:backtest] ${error.stack ?? error.message}`);
    await closeDb();
    process.exit(1);
  });

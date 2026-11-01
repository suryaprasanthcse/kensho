/**
 * Writes RESULTS.md from the tapes. The file is generated, not written by hand, and a test fails if it drifts from the
 * tapes. It has the pre-registered metrics first (PREREGISTRATION.md section 7), then two exploratory analyses that are
 * NOT pre-registered and are labelled so.
 *
 *   pnpm --filter @kensho/scene-gate results --tapes tapes --out RESULTS.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkTapes, listTapeFiles, loadPrompts, readTape, tapeOutcome, type PromptsFile, type TapeRow } from '../src/harness.ts';
import { STUDY_MODELS, STUDY_TAG } from '../src/study.ts';
import { wilson, type Interval } from '../src/stats.ts';

const LITE = 'gemini-3.5-flash-lite';
const FLASH = 'gemini-3.8-flash';
const OOB = 'OUT_OF_BOUNDS';

/** What the owner read in AI Studio. It is not in the tapes, so it is stated here and pinned by a test. */
const OWNER_READ = { date: '2026-11-01 at 19:08 IST', rpd: 20, tier: 'Free' } as const;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const interval = (k: number, n: number): string => {
  if (n === 0) return `${k}/${n} (no scenes)`;
  const w: Interval = wilson(k, n);
  return `${k}/${n} = ${pct(w.estimate)} (95% CI ${pct(w.lower)} to ${pct(w.upper)})`;
};
const dollars = (micro: number): string => `$${(micro / 1_000_000).toFixed(4)}`;
const table = (head: string[], rows: string[][]): string =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const key = (r: TapeRow): string => `${r.prompt_id}/${r.sample}`;

const generations = (rows: readonly TapeRow[], model: string): TapeRow[] => rows.filter((r) => r.kind === 'generate' && r.model === model);
const repairs = (rows: readonly TapeRow[], model: string): TapeRow[] => rows.filter((r) => r.kind === 'repair' && r.model === model);

export interface ExploratoryOne {
  /** Pairs (prompt_id/sample) where the second model produced a scene, i.e. its generation was not a transport failure. */
  readonly pairs: readonly string[];
  readonly reference: { readonly schemaValid: number; readonly fail: number };
  readonly subject: { readonly schemaValid: number; readonly fail: number; readonly schemaInvalid: number; readonly transportFailure: number; readonly missing: number };
}

/** E1: the subject model's failure rate on exactly the (prompt_id, sample) pairs where the reference model produced a scene. */
export function exploratoryOne(rows: readonly TapeRow[], subject: string, reference: string): ExploratoryOne {
  const pairs = generations(rows, reference).filter((r) => r.verdict).map(key);
  const wanted = new Set(pairs);
  const refRows = generations(rows, reference).filter((r) => r.verdict && wanted.has(key(r)));
  const subRows = new Map(generations(rows, subject).map((r) => [key(r), r]));
  let schemaValid = 0, fail = 0, schemaInvalid = 0, transportFailure = 0, missing = 0;
  for (const p of pairs) {
    const r = subRows.get(p);
    if (!r) missing++;
    else if (!r.verdict) transportFailure++;
    else if (r.verdict === 'schema_invalid') schemaInvalid++;
    else {
      schemaValid++;
      if (r.verdict === 'fail') fail++;
    }
  }
  const refValid = refRows.filter((r) => r.verdict !== 'schema_invalid');
  return {
    pairs,
    reference: { schemaValid: refValid.length, fail: refValid.filter((r) => r.verdict === 'fail').length },
    subject: { schemaValid, fail, schemaInvalid, transportFailure, missing },
  };
}

export interface ExploratoryTwo {
  readonly schemaValid: number;
  readonly failing: number;
  /** Failing scenes that still have at least one error code other than OUT_OF_BOUNDS. */
  readonly failingWithoutBounds: number;
  /** Failing scenes whose only error code is OUT_OF_BOUNDS. */
  readonly onlyBounds: number;
  readonly otherCodes: Readonly<Record<string, number>>;
}

/** E2: a model's failure rate if OUT_OF_BOUNDS were not an error: scenes with some other error code. */
export function exploratoryTwo(rows: readonly TapeRow[], model: string): ExploratoryTwo {
  const valid = generations(rows, model).filter((r) => r.verdict === 'pass' || r.verdict === 'fail');
  const failing = valid.filter((r) => r.verdict === 'fail');
  const other = failing.filter((r) => (r.codes ?? []).some((c) => c !== OOB));
  const counts: Record<string, number> = {};
  for (const r of failing) for (const c of r.codes ?? []) if (c !== OOB) counts[c] = (counts[c] ?? 0) + 1;
  return {
    schemaValid: valid.length,
    failing: failing.length,
    failingWithoutBounds: other.length,
    onlyBounds: failing.length - other.length,
    otherCodes: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/** How the attempts of the transport-failure tapes of each model ended: HTTP status or error class, and how many. */
export function failedAttempts(root: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const rel of listTapeFiles(root)) {
    const tape = readTape(join(root, ...rel.split('/')));
    if (tapeOutcome(tape) !== 'transport_failure') continue;
    const byModel = (out[tape.model] ??= {});
    for (const a of tape.attempts ?? []) {
      const label = a.http_status !== null ? `HTTP ${a.http_status}` : (a.error ?? 'no reply');
      byModel[label] = (byModel[label] ?? 0) + 1;
    }
  }
  return out;
}

const record = (o: Record<string, number>): string => (Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') : 'none');

function preregistered(rows: readonly TapeRow[], summary: ReturnType<typeof checkTapes>['summary'], prompts: PromptsFile): string {
  const category = new Map(prompts.prompts.map((p) => [p.id, p.category]));
  const out: string[] = [];
  for (const model of STUDY_MODELS) {
    const m = summary.models[model];
    if (!m) continue;
    const gens = generations(rows, model);
    const reps = repairs(rows, model);
    const failed = gens.filter((r) => r.verdict === 'fail').length;
    out.push(`### ${model}`, '');
    out.push(
      table(
        ['Metric', 'Value'],
        [
          ['Generation tapes', `${m.tapes} of 60 planned`],
          ['M1 unplayable rate: fail / (pass + fail)', interval(m.unplayable.unplayable, m.unplayable.schemaValid)],
          ['M1 unplayable rate: fail / all generation tapes', interval(m.unplayable.unplayable, m.unplayable.generations)],
          ...(['ordinary', 'structured'] as const).map((c) => {
            const g = gens.filter((r) => category.get(r.prompt_id!) === c && (r.verdict === 'pass' || r.verdict === 'fail'));
            return [`M1 by category: ${c}`, interval(g.filter((r) => r.verdict === 'fail').length, g.length)];
          }),
          ['M2 pass', interval(m.verdicts.pass, m.tapes)],
          ['M2 fail', interval(m.verdicts.fail, m.tapes)],
          ['M2 schema_invalid', `${interval(m.verdicts.schema_invalid, m.tapes)}; reasons: ${record(m.schema_invalid_reasons)}`],
          ['M2 transport_failure', interval(m.transport_failures, m.tapes)],
          ['M3 flip rate (a transport failure counts as an outcome)', `${interval(m.flip.flips, m.flip.triples)}; triples with fewer than 3 tapes left out: ${m.flip.incomplete}`],
          ['M3 flip rate, triples with no transport failure', interval(m.flip.excludingTransport.flips, m.flip.excludingTransport.triples)],
          ['M4 repair acceptance: accepted / failing scenes sent for repair', reps.length ? interval(reps.filter((r) => r.repair?.status === 'accepted').length, reps.length) : `no repair round (${failed} failing scenes)`],
          ['M5 repair success: accepted and the scene then passes / same', reps.length ? interval(reps.filter((r) => r.repair?.fully_fixed).length, reps.length) : 'no repair round'],
          ['M6 repair size (operations in the patch), all replies that were JSON objects', opsLine(reps.filter((r) => r.repair?.ops !== undefined).map((r) => r.repair!.ops!))],
          ['M6 repair size, accepted repairs only', opsLine(reps.filter((r) => r.repair?.status === 'accepted' && r.repair.ops !== undefined).map((r) => r.repair!.ops!))],
          ['D1 codes: scenes that have the code', record(m.error_codes)],
          ['D2 repair refusals by reason', record(reasonCounts(reps))],
          ['D3 attempts, and spend counted against the cap', `${m.attempts} attempts, ${dollars(m.spend_micro_usd)} (failed attempts counted at the worst case)`],
        ],
      ),
      '',
    );
  }
  return out.join('\n');
}

function opsLine(counts: number[]): string {
  if (!counts.length) return 'none';
  const s = [...counts].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return `n ${s.length}, total ${s.reduce((a, b) => a + b, 0)}, median ${median}, max ${s.at(-1)}`;
}

function reasonCounts(reps: readonly TapeRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reps) if (r.repair?.status === 'refused') out[r.repair.reason ?? 'unknown'] = (out[r.repair.reason ?? 'unknown'] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function buildResults(tapesRoot: string, prompts: PromptsFile, system: string): string {
  const report = checkTapes(tapesRoot, { expect: { prompts, system } });
  const { rows, summary } = report;
  const lite = summary.models[LITE];
  const flash = summary.models[FLASH];
  const e1 = exploratoryOne(rows, LITE, FLASH);
  const categoryOf = new Map(prompts.prompts.map((p) => [p.id, p.category]));
  const e1Categories = [...new Set(e1.pairs.map((p) => categoryOf.get(p.split('/')[0]!) ?? 'unknown'))];
  const e2 = exploratoryTwo(rows, LITE);
  const commits = summary.commits;
  const failed = failedAttempts(tapesRoot);
  const failedLine = (model: string): string => (failed[model] ? record(failed[model]!) : 'none');
  const flashFailed = Object.keys(failed[FLASH] ?? {});

  const lines: string[] = [
    '# scene-gate study: results as run',
    '',
    `**Final status: the study is complete for \`${LITE}\` and incomplete for \`${FLASH}\`.** \`${FLASH}\` was stopped by the pre-registered 10% rule after ${flash?.tapes ?? 0} of its 60 generations, because ${flash?.transport_failures ?? 0} of them ended as \`transport_failure\` (more than 10% of 60), and it got no repair round. The remaining ${60 - (flash?.tapes ?? 0)} generations do not exist, nothing was regenerated, and no amendment was run: one to finish them was drafted and withdrawn before it was frozen (\`AMENDMENT-1.md\`). The tapes are the record. Because the two models did not run the same scenes, **they are not comparable in section 1**.`,
    '',
    `Run once, at commit ${commits.join(', ')} (tag \`${STUDY_TAG}\`), with \`pnpm --filter @kensho/scene-gate study --tapes packages/scene-gate/tapes\`. Every tape was re-checked offline by \`check-tapes\`: ${summary.errors} unreadable tapes, ${summary.drift} tapes that differ from the frozen prompts. This file is generated by \`scripts/results.ts\` from the tapes; do not edit it by hand (a test fails if it drifts).`,
    '',
    '## 1. Pre-registered metrics',
    '',
    'Definitions are in `PREREGISTRATION.md` section 7. Intervals are Wilson 95%. Failed attempts count at the worst case against the cap, so the spend shown is an upper bound on the bill. "Unplayable" means only that a scene failed at least one of the ten static checks.',
    '',
    preregistered(rows, summary, prompts),
    `Total counted spend: ${dollars(summary.spend_micro_usd)} of the $10 cap.`,
    '',
    '### What the run did',
    '',
    `How the attempts of the transport-failure tapes ended (descriptive, not a pre-registered metric): ${LITE}: ${failedLine(LITE)}; ${FLASH}: ${failedLine(FLASH)}. The study never reads an error body, so a status is all there is to say about the cause.`,
    '',
    table(
      ['Phase', 'Model', 'Tapes', 'Transport failures'],
      [
        ['generate', LITE, String(lite?.tapes ?? 0), String(lite?.transport_failures ?? 0)],
        ['generate', FLASH, `${flash?.tapes ?? 0} (of 60; stopped by the 10% rule)`, String(flash?.transport_failures ?? 0)],
        ['repair', LITE, String(repairs(rows, LITE).length), String(repairs(rows, LITE).filter((r) => r.outcome === 'transport_failure').length)],
        ['repair', FLASH, '0 (not run: the model was stopped)', '0'],
      ],
    ),
    '',
    '### What is known about the 429s',
    '',
    `This is not from the tapes. The owner read it in AI Studio on ${OWNER_READ.date}: \`${FLASH}\` has a limit of ${OWNER_READ.rpd} requests per day (RPD) on the ${OWNER_READ.tier} tier. That is **consistent with a daily request quota** as the cause of the 429s of \`${FLASH}\`: ${(flash?.tapes ?? 0) - (flash?.transport_failures ?? 0)} replies were served before the first 429, and the model had been called earlier the same day. It is **not shown to be the cause**: the study never read the body of a 429. An amendment to finish the generations was withdrawn because ${OWNER_READ.rpd} requests a day is fewer than the ${60 - (flash?.tapes ?? 0)} to ${2 * (60 - (flash?.tapes ?? 0))} it needed (one request per missing generation, plus at most one repair each), and the owner chose not to depend on a change of billing tier or on a run spread over several days.`,
    '',
    '## 2. Exploratory analyses: NOT pre-registered',
    '',
    '**Both analyses below were chosen after the pre-registered results were seen. They are not part of the pre-registration, have no multiplicity adjustment, and must not be read as confirmatory.** They are here to describe the data, not to test anything.',
    '',
    `### E1. ${LITE} on the pairs where ${FLASH} produced a scene`,
    '',
    `The comparison in section 1 is not like for like, because \`${FLASH}\` only ran the first prompts. This restricts \`${LITE}\` to exactly the (prompt_id, sample) pairs where \`${FLASH}\` produced a scene (a generation that was not a transport failure): ${e1.pairs.length} pairs, ${prefixList(e1.pairs)}.`,
    '',
    table(
      ['Model', 'On those pairs: fail / schema-valid scenes'],
      [
        [LITE, `${interval(e1.subject.fail, e1.subject.schemaValid)}${e1.subject.schemaInvalid + e1.subject.transportFailure + e1.subject.missing ? ` (not counted: ${e1.subject.schemaInvalid} schema_invalid, ${e1.subject.transportFailure} transport failures, ${e1.subject.missing} with no tape)` : ''}`],
        [FLASH, interval(e1.reference.fail, e1.reference.schemaValid)],
      ],
    ),
    '',
    `The pairs are the earliest requests of \`${FLASH}\` in the file order (${e1Categories.length === 1 ? `all ${e1Categories[0]} prompts` : `prompts of ${e1Categories.join(' and ')} categories`}) and the ones the provider happened to serve before it began refusing requests; they are not a random sample. With ${e1.reference.schemaValid} scenes the intervals are wide, and \`${FLASH}\` and \`${LITE}\` also differ in default thinking.`,
    '',
    `### E2. ${LITE} excluding ${OOB}`,
    '',
    `Every failing scene of \`${LITE}\` has \`${OOB}\` (section 1, D1). This counts a scene as failing only if it has at least one error code other than \`${OOB}\`, that is, the failure rate if \`${OOB}\` were not an error.`,
    '',
    table(
      ['Quantity', 'Value'],
      [
        ['Fail with all ten checks (pre-registered M1)', interval(e2.failing, e2.schemaValid)],
        [`Fail with ${OOB} ignored`, interval(e2.failingWithoutBounds, e2.schemaValid)],
        [`Failing scenes whose only error code is ${OOB}`, `${e2.onlyBounds} of ${e2.failing}`],
        [`Other codes among failing scenes (scenes that have each)`, record(e2.otherCodes)],
      ],
    ),
    '',
    `\`${OOB}\` fires when any box, pickups included, extends outside \`bounds_mm\`. The ground is not a solid in these checks, so a floor slab centred below y = 0 inside bounds that start at y = 0 is flagged. This analysis shows how much of the failure rate rests on that one rule.`,
    '',
    '## 3. Limits',
    '',
    '- The checks are my own, on my own format; a failing scene is not shown to be unplayable in any engine, and a passing one is not shown to be playable. No human-labelled sample was made.',
    `- \`${FLASH}\` has ${flash?.tapes ?? 0} of 60 generations${flashFailed.length === 1 ? `, and every failed attempt of its transport failures was ${flashFailed[0]}` : ''} (see "What is known about the 429s" in section 1), so nothing about its scenes should be read from section 1 beyond what the tapes contain.`,
    '- Sampling and thinking were the providers\' defaults, which differ between the two models.',
    '',
  ];
  return lines.join('\n');
}

/** "ord-01 (3), ord-02 (3), ..." : the prompts and how many of their samples are in the list. */
function prefixList(pairs: readonly string[]): string {
  const by = new Map<string, number>();
  for (const p of pairs) by.set(p.split('/')[0]!, (by.get(p.split('/')[0]!) ?? 0) + 1);
  return [...by].map(([id, n]) => `${id} (${n})`).join(', ');
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { tapes: { type: 'string', default: 'tapes' }, out: { type: 'string', default: 'RESULTS.md' } } });
  const pkg = resolve(import.meta.dirname, '..');
  const text = buildResults(resolve(pkg, values.tapes!), loadPrompts(resolve(pkg, 'prompts', 'prompts.json')), readFileSync(resolve(pkg, 'prompts', 'system.md'), 'utf8'));
  writeFileSync(resolve(pkg, values.out!), text);
  console.log(`wrote ${resolve(pkg, values.out!)}`);
}

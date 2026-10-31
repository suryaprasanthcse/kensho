/**
 * One end-to-end run of the real runner on one non-study fixture prompt: the Gemini client, the transport policy, the
 * spend ledger, `runGenerations` and `check-tapes`, with the real prompts/system.md, the Gemini schema profile and the
 * study parameters. It sends ONE generation request (more only if the transport policy retries it) and writes one tape,
 * to a directory you name, which must be outside the repository so that no tape of this run can be taken for a study tape.
 *
 *   pnpm --filter @kensho/scene-gate e2e --out <dir outside the repo> [--model gemini-3.8-flash]
 *
 * It prints a few status lines: the run's status, what the tape is, and whether check-tapes accepts it. It prints no key,
 * no reply text and no error body.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { GeminiClient, type GeminiFetch } from '../src/gemini-client.ts';
import { checkTapes } from '../src/harness.ts';
import { sceneJsonSchema } from '../src/json-schema.ts';
import { runGenerations, type RunReport } from '../src/runner.ts';
import { SpendLedger } from '../src/spend.ts';
import { STUDY_MODELS, STUDY_PARAMETERS } from '../src/study.ts';
import { FIXTURE_PROMPT, readSystem } from './smoke-repair.ts';
import { KEY_VARIABLES, findKey, loadEnv } from './smoke-schema.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** True when `path` is the repository or anywhere inside it. */
export const insideRepo = (path: string, repoRoot: string = REPO_ROOT): boolean => {
  const rel = relative(repoRoot, resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export interface E2eOptions {
  readonly out: string;
  readonly model: string;
  readonly apiKey: string;
  readonly fetch?: GeminiFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly repoRoot?: string;
}

const dollars = (microUsd: number): string => `$${(microUsd / 1_000_000).toFixed(6)}`;

export async function runE2e(options: E2eOptions): Promise<{ lines: string[]; ok: boolean; report: RunReport | null }> {
  if (insideRepo(options.out, options.repoRoot)) {
    return { lines: ['refused: --out must be outside the repository, so that no tape of this run can be taken for a study tape'], ok: false, report: null };
  }
  const client = new GeminiClient({ apiKey: options.apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const ledger = new SpendLedger();
  const report = await runGenerations({
    model: options.model,
    parameters: STUDY_PARAMETERS,
    system: readSystem(),
    prompts: [{ id: 'fixture-01', text: FIXTURE_PROMPT }],
    samples: 1,
    jsonSchema: sceneJsonSchema('gemini'),
    deps: {
      client,
      tapeRoot: resolve(options.out),
      ledger,
      sleep: options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
      now: options.now ?? (() => new Date()),
    },
  });

  const checked = checkTapes(resolve(options.out));
  const row = checked.rows.find((r) => r.kind === 'generate');
  const summary = checked.summary.models[options.model];
  const lines = [
    `e2e ${options.model}: run ${report.status}${report.stopped ? ` (stopped: ${report.stopped})` : ''}, ${report.written} tape written, ${report.transport_failures} transport failures, ${summary?.attempts ?? 0} attempts, ${dollars(report.spent_micro_usd)} counted against the cap`,
  ];
  let consistent = false;
  if (row) {
    const tape = readTapeUsage(resolve(options.out), options.model);
    consistent = tape.consistent;
    const outcome = row.outcome ?? row.verdict;
    lines.push(
      `tape: ${outcome}${row.codes?.length ? ` (${row.codes.join(', ')})` : ''}${row.invalid_reason ? ` (${row.invalid_reason})` : ''}; check-tapes: ${checked.summary.errors === 0 ? 'reads and checks it, no errors' : `${checked.summary.errors} errors`}; usage ${tape.described}`,
    );
  } else {
    lines.push('tape: none written');
  }
  const ok = report.status === 'complete' && report.written === 1 && checked.summary.errors === 0 && row !== undefined && row.outcome === undefined && consistent;
  return { lines, ok, report };
}

/** Whether the tape's usage adds up: total = prompt + candidates + thoughts, and every count is present. */
function readTapeUsage(root: string, model: string): { consistent: boolean; described: string } {
  const row = checkTapes(root).rows.find((r) => r.kind === 'generate' && r.model === model);
  if (!row) return { consistent: false, described: 'missing' };
  const tape = JSON.parse(readFileSync(resolve(root, ...(row.path.split('/'))), 'utf8')) as { usage?: Record<string, number | null> };
  const u = tape.usage;
  if (!u) return { consistent: false, described: 'not reported' };
  const { promptTokenCount: p, candidatesTokenCount: c, thoughtsTokenCount: t, totalTokenCount: total } = u;
  const present = [p, c, total].every((v) => typeof v === 'number');
  const sum = (p ?? 0) + (c ?? 0) + (t ?? 0);
  const adds = present && sum === total;
  return { consistent: adds, described: `${adds ? 'adds up' : 'does not add up'} (prompt ${p}, candidates ${c}, thoughts ${t ?? 'none'}, total ${total})` };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, model: { type: 'string', default: STUDY_MODELS[0] } } });
  const apiKey = findKey(loadEnv(), KEY_VARIABLES.gemini);
  if (!values.out || !apiKey) {
    console.error(!values.out ? 'usage: e2e --out <dir outside the repo> [--model <gemini model id>]' : `no Gemini key: set one of ${KEY_VARIABLES.gemini.join(', ')}`);
    process.exitCode = 2;
  } else {
    const { lines, ok } = await runE2e({ out: values.out, model: values.model!, apiKey });
    for (const line of lines) console.log(line);
    process.exitCode = ok ? 0 : 1;
  }
}

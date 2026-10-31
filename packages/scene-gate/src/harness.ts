import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { z } from 'zod';
import { evaluateRaw, evaluateValue, type CheckOptions } from './check.ts';
import { parseRawOutput } from './parse.ts';
import { applyRepair } from './repair.ts';
import { flipRate, unplayableRate, wilson, type FlipRate, type Interval, type UnplayableRate } from './stats.ts';
import { sha256Hex, verdictRecord, type Verdict } from './verdict.ts';
import { compareCodeUnits } from './canonical.ts';

/* ------------------------------------------------------------------------------------------------------------------
 * Tapes
 *
 * A tape is one recorded model call, written once and never edited. Everything the checks report is derived from
 * `raw_output` offline, so the verdicts can be recomputed, and audited, long after the model call.
 *
 * Layout:  <root>/<model-slug>/<prompt_id>/<sample>.<kind>.json
 *   kind "generate": raw_output is the model's scene text.
 *   kind "repair":   raw_output is the model's RFC 6902 patch for the generate tape with the same model, prompt and
 *                    sample.
 * ---------------------------------------------------------------------------------------------------------------- */

export const TAPE_VERSION = 'scene-gate-tape/1';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const TapeSchema = z.strictObject({
  version: z.literal(TAPE_VERSION),
  kind: z.enum(['generate', 'repair']),
  /** The model id as the provider names it. */
  model: z.string().min(1),
  /** Sampling parameters as sent: temperature, max tokens, seed, and so on. */
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  prompt_id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  /** SHA-256 of the prompt text. */
  prompt_hash: Sha256,
  /** SHA-256 of prompts/system.md. */
  system_hash: Sha256,
  /** 0-based index of the repeated generation for this model and prompt. */
  sample: z.number().int().min(0),
  raw_output: z.string(),
  /** The provider's stop reason, when it gave one. Only consulted when raw_output does not parse. */
  finish_reason: z.string().nullable().optional(),
  /** ISO 8601 UTC, written by the recorder. The checks never read it. */
  timestamp: z.iso.datetime(),
});
export type Tape = z.infer<typeof TapeSchema>;
export type TapeKind = Tape['kind'];

const slug = (model: string): string => model.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');

export const tapePath = (root: string, tape: Pick<Tape, 'model' | 'prompt_id' | 'sample' | 'kind'>): string =>
  join(root, slug(tape.model), tape.prompt_id, `${tape.sample}.${tape.kind}.json`);

/** Writes a tape. Refuses to overwrite: a tape that exists is evidence. */
export function writeTape(root: string, tape: Tape): string {
  const path = tapePath(root, TapeSchema.parse(tape));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tape, null, 2) + '\n', { flag: 'wx' });
  return path;
}

export const readTape = (path: string): Tape => TapeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

/* ------------------------------------------------------------------------------------------------------------------
 * Prompts
 * ---------------------------------------------------------------------------------------------------------------- */

export const PromptsFileSchema = z.strictObject({
  status: z.enum(['DRAFT', 'FROZEN']),
  note: z.string(),
  prompts: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]+$/), category: z.enum(['ordinary', 'structured']), text: z.string().min(1) })),
});
export type PromptsFile = z.infer<typeof PromptsFileSchema>;

export const loadPrompts = (path: string): PromptsFile => PromptsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

/* ------------------------------------------------------------------------------------------------------------------
 * API clients: NOT IMPLEMENTED, on purpose.
 *
 * Generation happens after the prompts are frozen and the commit is pushed. Nothing in this package calls a model. A
 * future runner implements `SceneGenerator`, builds tapes with `toTape`, and writes them with `writeTape`.
 * ---------------------------------------------------------------------------------------------------------------- */

export interface GenerationRequest {
  readonly model: string;
  readonly parameters: Tape['parameters'];
  readonly system: string;
  readonly prompt: { readonly id: string; readonly text: string };
  readonly sample: number;
  /** The JSON Schema from schema/ (the profile that matches the provider), for providers that take a structured-output schema. */
  readonly jsonSchema: Record<string, unknown>;
}

export interface RepairRequest extends GenerationRequest {
  /** The failing scene, as recorded. */
  readonly sceneText: string;
  /** The diagnostics the repair round is told about. */
  readonly diagnostics: readonly unknown[];
}

export interface ModelResponse {
  readonly rawOutput: string;
  readonly finishReason: string | null;
}

export interface SceneGenerator {
  /** Returns the model's scene text. */
  generate(request: GenerationRequest): Promise<ModelResponse>;
  /** Returns the model's RFC 6902 patch as text. */
  repair(request: RepairRequest): Promise<ModelResponse>;
}

/** Builds a tape from a response. The timestamp is passed in so this stays a pure function. */
export function toTape(kind: TapeKind, request: GenerationRequest, response: ModelResponse, timestamp: string): Tape {
  return {
    version: TAPE_VERSION,
    kind,
    model: request.model,
    parameters: request.parameters,
    prompt_id: request.prompt.id,
    prompt_hash: sha256Hex(request.prompt.text),
    system_hash: sha256Hex(request.system),
    sample: request.sample,
    raw_output: response.rawOutput,
    finish_reason: response.finishReason,
    timestamp,
  };
}

/* ------------------------------------------------------------------------------------------------------------------
 * check-tapes: offline, deterministic re-check of recorded tapes.
 * ---------------------------------------------------------------------------------------------------------------- */

export interface CheckTapesOptions extends CheckOptions {
  /** When given, tapes are compared with these frozen prompts and system text, and any drift is reported. */
  readonly expect?: { readonly prompts: PromptsFile; readonly system: string };
}

export interface TapeRow {
  readonly path: string;
  readonly model?: string;
  readonly prompt_id?: string;
  readonly sample?: number;
  readonly kind?: TapeKind;
  readonly verdict?: Verdict;
  readonly hash?: string;
  readonly codes?: readonly string[];
  /** For schema_invalid generate tapes: why. */
  readonly invalid_reason?: string;
  /** For repair tapes: what the acceptance rule decided. */
  readonly repair?: { readonly status: 'accepted' | 'refused'; readonly reason?: string; readonly fully_fixed?: boolean };
  /** Set when the tape differs from the frozen prompts or system text. */
  readonly drift?: 'unknown_prompt' | 'prompt_hash' | 'system_hash';
  /** Set when the tape could not be used. */
  readonly error?: string;
}

export interface ModelSummary {
  readonly tapes: number;
  readonly verdicts: Readonly<Record<Verdict, number>>;
  readonly schema_invalid_reasons: Readonly<Record<string, number>>;
  readonly error_codes: Readonly<Record<string, number>>;
  readonly unplayable: UnplayableRate;
  readonly flip: FlipRate;
}

export interface TapeReport {
  readonly rows: readonly TapeRow[];
  readonly summary: {
    readonly models: Readonly<Record<string, ModelSummary>>;
    readonly repair: {
      readonly attempted: number;
      readonly accepted: number;
      readonly fully_fixed: number;
      readonly refusals: Readonly<Record<string, number>>;
      readonly accepted_interval: Interval | null;
    };
    readonly drift: number;
    readonly errors: number;
  };
}

const sortedRecord = <T>(entries: Map<string, T>): Record<string, T> =>
  Object.fromEntries([...entries].sort(([a], [b]) => compareCodeUnits(a, b)));

const bump = (m: Map<string, number>, key: string): void => void m.set(key, (m.get(key) ?? 0) + 1);

/** Every `*.json` file under `root`, in code unit order of its relative path. */
export const listTapeFiles = (root: string): string[] =>
  (readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.split(sep).join('/'))
    .sort(compareCodeUnits);

export function checkTapes(root: string, options: CheckTapesOptions = {}): TapeReport {
  const rows: TapeRow[] = [];
  const generated = new Map<string, { tape: Tape; scene: unknown }>();
  const repairs: { rel: string; tape: Tape }[] = [];
  const key = (t: Pick<Tape, 'model' | 'prompt_id' | 'sample'>): string => JSON.stringify([t.model, t.prompt_id, t.sample]);

  const drift = (tape: Tape): TapeRow['drift'] => {
    if (!options.expect) return undefined;
    const prompt = options.expect.prompts.prompts.find((p) => p.id === tape.prompt_id);
    if (!prompt) return 'unknown_prompt';
    if (sha256Hex(prompt.text) !== tape.prompt_hash) return 'prompt_hash';
    if (sha256Hex(options.expect.system) !== tape.system_hash) return 'system_hash';
    return undefined;
  };

  for (const rel of listTapeFiles(root)) {
    let tape: Tape;
    try {
      tape = readTape(join(root, ...rel.split('/')));
    } catch (error) {
      rows.push({ path: rel, error: error instanceof Error ? error.message.split('\n')[0]! : String(error) });
      continue;
    }
    const base = { path: rel, model: tape.model, prompt_id: tape.prompt_id, sample: tape.sample, kind: tape.kind, drift: drift(tape) };
    if (tape.kind === 'repair') {
      repairs.push({ rel, tape });
      continue;
    }
    const evaluation = evaluateRaw(tape.raw_output, options, tape.finish_reason);
    const record = verdictRecord(evaluation);
    generated.set(key(tape), { tape, scene: evaluation.kind === 'checked' ? evaluation.scene : undefined });
    rows.push({
      ...base,
      verdict: record.verdict,
      hash: record.hash,
      codes: record.codes,
      ...(evaluation.kind === 'schema_invalid' ? { invalid_reason: evaluation.reason } : {}),
    });
  }

  const refusals = new Map<string, number>();
  let accepted = 0;
  let fullyFixed = 0;
  for (const { rel, tape } of repairs) {
    const base = { path: rel, model: tape.model, prompt_id: tape.prompt_id, sample: tape.sample, kind: tape.kind, drift: drift(tape) };
    const parent = generated.get(key(tape));
    if (!parent) {
      rows.push({ ...base, error: 'no generate tape for this repair' });
      continue;
    }
    const patch = parseRawOutput(tape.raw_output, tape.finish_reason);
    const result = applyRepair(parent.scene, patch.ok ? patch.value : null, options);
    if (result.status === 'accepted') {
      accepted++;
      const fixed = !result.after.some((d) => d.severity === 'error');
      if (fixed) fullyFixed++;
      const after = verdictRecord(evaluateValue(result.scene, options));
      rows.push({ ...base, verdict: after.verdict, hash: after.hash, repair: { status: 'accepted', fully_fixed: fixed } });
    } else {
      const reason = patch.ok ? result.reason : 'invalid_patch';
      bump(refusals, reason);
      rows.push({ ...base, repair: { status: 'refused', reason } });
    }
  }
  rows.sort((a, b) => compareCodeUnits(a.path, b.path));

  const byModel = new Map<string, TapeRow[]>();
  for (const r of rows) {
    if (r.kind !== 'generate' || !r.model || !r.verdict) continue;
    const list = byModel.get(r.model);
    if (list) list.push(r);
    else byModel.set(r.model, [r]);
  }
  const models = new Map<string, ModelSummary>();
  for (const [model, list] of byModel) {
    const verdicts = { pass: 0, fail: 0, schema_invalid: 0 };
    const reasons = new Map<string, number>();
    const codes = new Map<string, number>();
    for (const r of list) {
      verdicts[r.verdict!]++;
      if (r.invalid_reason) bump(reasons, r.invalid_reason);
      if (r.verdict === 'fail') for (const c of r.codes ?? []) bump(codes, c);
    }
    models.set(model, {
      tapes: list.length,
      verdicts,
      schema_invalid_reasons: sortedRecord(reasons),
      error_codes: sortedRecord(codes),
      unplayable: unplayableRate(list.map((r) => r.verdict!)),
      flip: flipRate(list.map((r) => ({ model, prompt_id: r.prompt_id!, verdict: r.verdict! }))),
    });
  }

  return {
    rows,
    summary: {
      models: sortedRecord(models),
      repair: {
        attempted: repairs.length,
        accepted,
        fully_fixed: fullyFixed,
        refusals: sortedRecord(refusals),
        accepted_interval: repairs.length ? wilson(accepted, repairs.length) : null,
      },
      drift: rows.filter((r) => r.drift).length,
      errors: rows.filter((r) => r.error).length,
    },
  };
}

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { z } from 'zod';
import { compareCodeUnits } from './canonical.ts';
import { evaluateRaw, evaluateValue, type CheckOptions } from './check.ts';
import { parseRawOutput } from './parse.ts';
import { repairFromScene } from './repair.ts';
import { flipRate, unplayableRate, wilson, type FlipRate, type Interval, type Outcome, type UnplayableRate } from './stats.ts';
import { AttemptSchema, type Attempt, type ModelResponse, type ProviderReply } from './transport.ts';
import { sha256Hex, verdictRecord, type Verdict } from './verdict.ts';

/* ------------------------------------------------------------------------------------------------------------------
 * Tapes
 *
 * A tape is one recorded model call, written once and never edited. Everything the checks report is derived from
 * `raw_output` offline, so the verdicts can be recomputed, and audited, long after the model call.
 *
 * Layout:  <root>/<model-slug>/<prompt_id>/<sample>.<kind>.json
 *   kind "generate": raw_output is the model's scene text.
 *   kind "repair":   raw_output is the model's corrected full scene for the generate tape with the same model, prompt
 *                    and sample. The RFC 6902 patch is computed from it offline with `compare`, so it can be recomputed.
 *
 * outcome "response" (the default): a reply arrived and raw_output holds it, whatever it says.
 * outcome "transport_failure": no reply arrived after the retries. raw_output is empty and `attempts` says what happened.
 * ---------------------------------------------------------------------------------------------------------------- */

export const TAPE_VERSION = 'scene-gate-tape/1';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const TapeSchema = z
  .strictObject({
    version: z.literal(TAPE_VERSION),
    kind: z.enum(['generate', 'repair']),
    /** `response` when absent. */
    outcome: z.enum(['response', 'transport_failure']).optional(),
    /** The model id as the provider names it. */
    model: z.string().min(1),
    /** Parameters as sent. Temperature, thinking and the like are omitted (the provider default) and so are not listed. */
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
    /**
     * Token usage of the reply that was kept, as the provider reported it (for Gemini: promptTokenCount,
     * candidatesTokenCount, thoughtsTokenCount, totalTokenCount). Never read by the checks.
     */
    usage: z.record(z.string(), z.number().int().nullable()).optional(),
    /** Every attempt made for this request, in order, failed ones included. Each counted against the spend cap. */
    attempts: z.array(AttemptSchema).optional(),
    /** ISO 8601 UTC, written by the recorder. The checks never read it. */
    timestamp: z.iso.datetime(),
  })
  .refine((t) => t.outcome !== 'transport_failure' || (t.raw_output === '' && (t.attempts?.length ?? 0) > 0 && t.usage === undefined), {
    message: 'a transport_failure tape has empty raw_output, no usage, and at least one attempt',
  });
export type Tape = z.infer<typeof TapeSchema>;
export type TapeKind = Tape['kind'];

export const tapeOutcome = (tape: Pick<Tape, 'outcome'>): 'response' | 'transport_failure' => tape.outcome ?? 'response';

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
  prompts: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]+$/), category: z.enum(['ordinary', 'structured']), text: z.string().min(1) })),
});
export type PromptsFile = z.infer<typeof PromptsFileSchema>;

export const loadPrompts = (path: string): PromptsFile => PromptsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

/* ------------------------------------------------------------------------------------------------------------------
 * API clients: NOT IMPLEMENTED, on purpose.
 *
 * Generation happens after the prompts are frozen and the commit is pushed. Nothing in this package calls a model. A
 * future provider client implements `ProviderClient`; the runner (src/runner.ts) drives it under the transport policy
 * (src/transport.ts) and writes the tapes.
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

/**
 * A repair request carries the same system text and schema profile as a generation. Its user message is built by
 * `renderRepairMessage` (src/repair-request.ts) from prompts/repair.md, the original prompt, the scene and its
 * diagnostics, and the reply is a corrected full scene.
 */
export interface RepairRequest extends GenerationRequest {
  /** The user message for the repair, already rendered. */
  readonly message: string;
}

/**
 * One attempt at a request. Returns the HTTP status and, for a 2xx, the response. Throws on a network error or when
 * `timeoutMs` passes; the error's `name` (for example `TimeoutError`) is what the tape records.
 */
export interface ProviderClient {
  generate(request: GenerationRequest, timeoutMs: number): Promise<ProviderReply>;
  repair(request: RepairRequest, timeoutMs: number): Promise<ProviderReply>;
}

const tapeFields = (kind: TapeKind, request: GenerationRequest, timestamp: string) => ({
  version: TAPE_VERSION as typeof TAPE_VERSION,
  kind,
  model: request.model,
  parameters: request.parameters,
  prompt_id: request.prompt.id,
  prompt_hash: sha256Hex(request.prompt.text),
  system_hash: sha256Hex(request.system),
  sample: request.sample,
  timestamp,
});

/** Builds a tape from a response. The timestamp is passed in so this stays a pure function. */
export function toTape(kind: TapeKind, request: GenerationRequest, response: ModelResponse, timestamp: string, attempts?: readonly Attempt[]): Tape {
  return {
    ...tapeFields(kind, request, timestamp),
    raw_output: response.rawOutput,
    finish_reason: response.finishReason,
    ...(response.usage ? { usage: { ...response.usage } } : {}),
    ...(attempts ? { attempts: [...attempts] } : {}),
  };
}

/** The tape of a request that got no reply after the retries. It is kept in every denominator and never regenerated. */
export function toTransportFailureTape(kind: TapeKind, request: GenerationRequest, attempts: readonly Attempt[], timestamp: string): Tape {
  return { ...tapeFields(kind, request, timestamp), outcome: 'transport_failure', raw_output: '', attempts: [...attempts] };
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
  /** `transport_failure` when no reply arrived; such a row has no verdict. */
  readonly outcome?: 'transport_failure';
  readonly hash?: string;
  readonly codes?: readonly string[];
  /** For schema_invalid generate tapes: why. */
  readonly invalid_reason?: string;
  /** Attempts made, when the tape logged them. */
  readonly attempts?: number;
  /** Micro-dollars this tape's attempts counted against the cap. */
  readonly spend_micro_usd?: number;
  /** For repair tapes: what the acceptance rule decided, and the size of the patch from the original to the reply. */
  readonly repair?: {
    readonly status: 'accepted' | 'refused';
    readonly reason?: string;
    readonly fully_fixed?: boolean;
    /** RFC 6902 operations in the computed patch; absent when the reply was not a JSON object. */
    readonly ops?: number;
  };
  /** Set when the tape differs from the frozen prompts or system text. */
  readonly drift?: 'unknown_prompt' | 'prompt_hash' | 'system_hash';
  /** Set when the tape could not be used. */
  readonly error?: string;
}

export interface ModelSummary {
  /** Generation tapes, transport failures included: this is the denominator of every share. */
  readonly tapes: number;
  readonly verdicts: Readonly<Record<Verdict, number>>;
  /** Generations that got no reply after the retries. Reported apart from schema_invalid and never regenerated. */
  readonly transport_failures: number;
  readonly schema_invalid_reasons: Readonly<Record<string, number>>;
  readonly error_codes: Readonly<Record<string, number>>;
  readonly unplayable: UnplayableRate;
  readonly flip: FlipRate;
  /** Attempts made by this model's generation and repair requests, and what they counted against the cap. */
  readonly attempts: number;
  readonly spend_micro_usd: number;
}

export interface OpsSummary {
  readonly n: number;
  readonly total: number;
  readonly median: number | null;
  readonly max: number | null;
}

const summariseOps = (counts: readonly number[]): OpsSummary => {
  const sorted = [...counts].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length === 0 ? null : sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { n: sorted.length, total: sorted.reduce((a, b) => a + b, 0), median, max: sorted.at(-1) ?? null };
};

export interface TapeReport {
  readonly rows: readonly TapeRow[];
  readonly summary: {
    readonly models: Readonly<Record<string, ModelSummary>>;
    readonly repair: {
      /** Repair requests, transport failures included. */
      readonly attempted: number;
      readonly accepted: number;
      readonly fully_fixed: number;
      readonly refusals: Readonly<Record<string, number>>;
      readonly accepted_interval: Interval | null;
      /** Operations per repair, over the replies that were JSON objects. */
      readonly ops: OpsSummary;
      /** The same, over accepted repairs only. */
      readonly ops_accepted: OpsSummary;
    };
    /** Everything counted against the cap, all models, in micro-dollars. */
    readonly spend_micro_usd: number;
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

const spendOf = (tape: Tape): number => (tape.attempts ?? []).reduce((total, a) => total + a.cost_micro_usd, 0);

export function checkTapes(root: string, options: CheckTapesOptions = {}): TapeReport {
  const rows: TapeRow[] = [];
  const generated = new Map<string, { tape: Tape; scene: unknown }>();
  const repairs: { rel: string; tape: Tape }[] = [];
  const spendByModel = new Map<string, number>();
  const attemptsByModel = new Map<string, number>();
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
    const spend = spendOf(tape);
    spendByModel.set(tape.model, (spendByModel.get(tape.model) ?? 0) + spend);
    attemptsByModel.set(tape.model, (attemptsByModel.get(tape.model) ?? 0) + (tape.attempts?.length ?? 0));
    const base = {
      path: rel,
      model: tape.model,
      prompt_id: tape.prompt_id,
      sample: tape.sample,
      kind: tape.kind,
      drift: drift(tape),
      ...(tape.attempts ? { attempts: tape.attempts.length, spend_micro_usd: spend } : {}),
    };
    if (tape.kind === 'repair') {
      repairs.push({ rel, tape });
      continue;
    }
    if (tapeOutcome(tape) === 'transport_failure') {
      generated.set(key(tape), { tape, scene: undefined });
      rows.push({ ...base, outcome: 'transport_failure' });
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
  const opsAll: number[] = [];
  const opsAccepted: number[] = [];
  for (const { rel, tape } of repairs) {
    const spend = spendOf(tape);
    const base = {
      path: rel,
      model: tape.model,
      prompt_id: tape.prompt_id,
      sample: tape.sample,
      kind: tape.kind,
      drift: drift(tape),
      ...(tape.attempts ? { attempts: tape.attempts.length, spend_micro_usd: spend } : {}),
    };
    const parent = generated.get(key(tape));
    if (!parent) {
      rows.push({ ...base, error: 'no generate tape for this repair' });
      continue;
    }
    if (tapeOutcome(tape) === 'transport_failure') {
      bump(refusals, 'transport_failure');
      rows.push({ ...base, outcome: 'transport_failure', repair: { status: 'refused', reason: 'transport_failure' } });
      continue;
    }
    const reply = parseRawOutput(tape.raw_output, tape.finish_reason);
    if (!reply.ok) {
      bump(refusals, 'unparseable_reply');
      rows.push({ ...base, repair: { status: 'refused', reason: 'unparseable_reply' } });
      continue;
    }
    const result = repairFromScene(parent.scene, reply.value, options);
    if (result.ops !== null) opsAll.push(result.ops);
    if (result.status === 'accepted') {
      accepted++;
      if (result.ops !== null) opsAccepted.push(result.ops);
      const fixed = !result.after.some((d) => d.severity === 'error');
      if (fixed) fullyFixed++;
      const after = verdictRecord(evaluateValue(result.scene, options));
      rows.push({ ...base, verdict: after.verdict, hash: after.hash, repair: { status: 'accepted', fully_fixed: fixed, ...(result.ops !== null ? { ops: result.ops } : {}) } });
    } else {
      bump(refusals, result.reason);
      rows.push({ ...base, repair: { status: 'refused', reason: result.reason, ...(result.ops !== null ? { ops: result.ops } : {}) } });
    }
  }
  rows.sort((a, b) => compareCodeUnits(a.path, b.path));

  const byModel = new Map<string, TapeRow[]>();
  for (const r of rows) {
    if (r.kind !== 'generate' || !r.model || !(r.verdict || r.outcome)) continue;
    const list = byModel.get(r.model);
    if (list) list.push(r);
    else byModel.set(r.model, [r]);
  }
  const models = new Map<string, ModelSummary>();
  for (const [model, list] of byModel) {
    const verdicts = { pass: 0, fail: 0, schema_invalid: 0 };
    const reasons = new Map<string, number>();
    const codes = new Map<string, number>();
    let transportFailures = 0;
    const outcomeOf = (r: TapeRow): Outcome => r.verdict ?? 'transport_failure';
    for (const r of list) {
      if (r.verdict) verdicts[r.verdict]++;
      else transportFailures++;
      if (r.invalid_reason) bump(reasons, r.invalid_reason);
      if (r.verdict === 'fail') for (const c of r.codes ?? []) bump(codes, c);
    }
    models.set(model, {
      tapes: list.length,
      verdicts,
      transport_failures: transportFailures,
      schema_invalid_reasons: sortedRecord(reasons),
      error_codes: sortedRecord(codes),
      unplayable: unplayableRate(list.map(outcomeOf)),
      flip: flipRate(list.map((r) => ({ model, prompt_id: r.prompt_id!, verdict: outcomeOf(r) }))),
      attempts: attemptsByModel.get(model) ?? 0,
      spend_micro_usd: spendByModel.get(model) ?? 0,
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
        ops: summariseOps(opsAll),
        ops_accepted: summariseOps(opsAccepted),
      },
      spend_micro_usd: [...spendByModel.values()].reduce((a, b) => a + b, 0),
      drift: rows.filter((r) => r.drift).length,
      errors: rows.filter((r) => r.error).length,
    },
  };
}

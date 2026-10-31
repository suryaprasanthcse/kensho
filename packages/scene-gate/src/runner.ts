import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateRaw, type CheckOptions } from './check.ts';
import {
  tapeOutcome,
  tapePath,
  listTapeFiles,
  readTape,
  toTape,
  toTransportFailureTape,
  writeTape,
  type GenerationRequest,
  type ProviderClient,
  type RepairRequest,
  type Tape,
} from './harness.ts';
import { renderRepairMessage } from './repair-request.ts';
import { requestWithRetries, transportFailureLimitExceeded, type RequestOutcome, type TransportDeps } from './transport.ts';

/**
 * The run loops of the study, with every external thing injected: the provider client, the clock, sleeping, and the
 * spend ledger. Nothing here calls a model; `client` is the interface `ProviderClient` in harness.ts, which has no
 * implementation in this package.
 *
 * Rules, all pinned by tests:
 * - Requests go one at a time, in prompt order then sample order.
 * - A request that already has a tape is skipped, never repeated: a tape is evidence and nothing is regenerated.
 * - Each request follows the transport policy (src/transport.ts). One that gets no reply after the retries is written as
 *   a `transport_failure` tape, and the loop goes on.
 * - If more than 10% of a model's planned generations end that way, that model stops and is reported incomplete.
 * - A status that is not retried and not a reply (any other 4xx) stops the run as `rejected`: it is a setup error.
 * - Before every attempt the spend cap is checked; if the attempt could reach the cap it is not sent and the run stops.
 */
export interface RunnerDeps extends TransportDeps {
  readonly client: ProviderClient;
  readonly tapeRoot: string;
}

export type StopReason = 'spend_cap' | 'transport_failure_limit' | 'rejected';

export interface RunReport {
  readonly model: string;
  readonly phase: 'generate' | 'repair';
  readonly status: 'complete' | 'incomplete';
  readonly stopped: StopReason | null;
  readonly detail: string | null;
  /** Requests planned for this phase. */
  readonly planned: number;
  /** Tapes written by this call. */
  readonly written: number;
  /** Tapes that already existed and were left alone. */
  readonly skipped: number;
  /** Requests that ended as transport_failure, existing tapes included. */
  readonly transport_failures: number;
  /** What the ledger holds after this call, in micro-dollars. */
  readonly spent_micro_usd: number;
}

export interface GenerationConfig {
  readonly model: string;
  readonly parameters: Tape['parameters'];
  readonly system: string;
  readonly prompts: readonly { readonly id: string; readonly text: string }[];
  /** Runs per prompt: 3 in the study. */
  readonly samples: number;
  readonly jsonSchema: Record<string, unknown>;
  readonly deps: RunnerDeps;
}

const spendOfTape = (tape: Tape): number => (tape.attempts ?? []).reduce((total, a) => total + a.cost_micro_usd, 0);

interface Step {
  readonly stop: StopReason | null;
  readonly detail: string | null;
  readonly written: boolean;
  readonly failed: boolean;
}

/** Sends one request, writes its tape, and says whether the loop must stop. */
async function perform(
  kind: 'generate' | 'repair',
  request: GenerationRequest | RepairRequest,
  call: (timeoutMs: number) => ReturnType<ProviderClient['generate']>,
  deps: RunnerDeps,
): Promise<Step> {
  const outcome: RequestOutcome = await requestWithRetries(request.model, call, deps);
  const stamp = deps.now().toISOString();
  switch (outcome.kind) {
    case 'response':
      writeTape(deps.tapeRoot, toTape(kind, request, outcome.reply.response, stamp, outcome.attempts));
      return { stop: null, detail: null, written: true, failed: false };
    case 'transport_failure':
      writeTape(deps.tapeRoot, toTransportFailureTape(kind, request, outcome.attempts, stamp));
      return { stop: null, detail: null, written: true, failed: true };
    case 'spend_cap': {
      // Attempts already made were billed; keep them on a tape so the spend stays on the record.
      const wrote = outcome.attempts.length > 0;
      if (wrote) writeTape(deps.tapeRoot, toTransportFailureTape(kind, request, outcome.attempts, stamp));
      return { stop: 'spend_cap', detail: 'the next attempt could reach the spend cap', written: wrote, failed: wrote };
    }
    case 'abort':
      return { stop: 'rejected', detail: `HTTP ${outcome.status}`, written: false, failed: false };
  }
}

const report = (
  model: string,
  phase: RunReport['phase'],
  planned: number,
  counts: { written: number; skipped: number; failures: number },
  stop: { stop: StopReason | null; detail: string | null },
  deps: RunnerDeps,
): RunReport => ({
  model,
  phase,
  status: stop.stop ? 'incomplete' : 'complete',
  stopped: stop.stop,
  detail: stop.detail,
  planned,
  written: counts.written,
  skipped: counts.skipped,
  transport_failures: counts.failures,
  spent_micro_usd: deps.ledger.spent,
});

/** The generation phase for one model: every prompt, `samples` runs each. */
export async function runGenerations(config: GenerationConfig): Promise<RunReport> {
  const { model, deps } = config;
  const planned = config.prompts.length * config.samples;
  const counts = { written: 0, skipped: 0, failures: 0 };
  let stop: { stop: StopReason | null; detail: string | null } = { stop: null, detail: null };

  outer: for (const prompt of config.prompts) {
    for (let sample = 0; sample < config.samples; sample++) {
      const request: GenerationRequest = { model, parameters: config.parameters, system: config.system, prompt, sample, jsonSchema: config.jsonSchema };
      const path = tapePath(deps.tapeRoot, { model, prompt_id: prompt.id, sample, kind: 'generate' });
      if (existsSync(path)) {
        const existing = readTape(path);
        counts.skipped++;
        deps.ledger.record(spendOfTape(existing));
        if (tapeOutcome(existing) === 'transport_failure') counts.failures++;
      } else {
        const step = await perform('generate', request, (t) => deps.client.generate(request, t), deps);
        if (step.written) counts.written++;
        if (step.failed) counts.failures++;
        if (step.stop) {
          stop = { stop: step.stop, detail: step.detail };
          break outer;
        }
      }
      if (transportFailureLimitExceeded(counts.failures, planned)) {
        stop = { stop: 'transport_failure_limit', detail: `${counts.failures} of ${planned} generations ended as transport_failure` };
        break outer;
      }
    }
  }
  return report(model, 'generate', planned, { ...counts }, stop, deps);
}

export interface RepairConfig {
  readonly model: string;
  readonly parameters: Tape['parameters'];
  readonly system: string;
  /** The text of prompts/repair.md. */
  readonly template: string;
  readonly prompts: readonly { readonly id: string; readonly text: string }[];
  readonly jsonSchema: Record<string, unknown>;
  readonly checkOptions?: CheckOptions;
  readonly deps: RunnerDeps;
}

/** The repair phase for one model: one request for every generation whose verdict is `fail`. Nothing else is repaired. */
export async function runRepairs(config: RepairConfig): Promise<RunReport> {
  const { model, deps } = config;
  const failing: { tape: Tape; scene: Parameters<typeof renderRepairMessage>[1]['scene']; diagnostics: Parameters<typeof renderRepairMessage>[1]['diagnostics'] }[] = [];
  for (const rel of listTapeFiles(deps.tapeRoot)) {
    const tape = readTape(join(deps.tapeRoot, ...rel.split('/')));
    if (tape.model !== model || tape.kind !== 'generate' || tapeOutcome(tape) !== 'response') continue;
    const evaluation = evaluateRaw(tape.raw_output, config.checkOptions, tape.finish_reason);
    if (evaluation.kind === 'checked' && evaluation.diagnostics.some((d) => d.severity === 'error')) {
      failing.push({ tape, scene: evaluation.scene, diagnostics: evaluation.diagnostics });
    }
  }

  const counts = { written: 0, skipped: 0, failures: 0 };
  let stop: { stop: StopReason | null; detail: string | null } = { stop: null, detail: null };
  for (const { tape, scene, diagnostics } of failing) {
    const prompt = config.prompts.find((p) => p.id === tape.prompt_id);
    if (!prompt) throw new Error(`no prompt ${tape.prompt_id} for the generate tape of ${model}`);
    const message = renderRepairMessage(config.template, { prompt: prompt.text, scene, diagnostics });
    const request: RepairRequest = { model, parameters: config.parameters, system: config.system, prompt, sample: tape.sample, jsonSchema: config.jsonSchema, message };
    const path = tapePath(deps.tapeRoot, { model, prompt_id: prompt.id, sample: tape.sample, kind: 'repair' });
    if (existsSync(path)) {
      const existing = readTape(path);
      counts.skipped++;
      deps.ledger.record(spendOfTape(existing));
      if (tapeOutcome(existing) === 'transport_failure') counts.failures++;
      continue;
    }
    const step = await perform('repair', request, (t) => deps.client.repair(request, t), deps);
    if (step.written) counts.written++;
    if (step.failed) counts.failures++;
    if (step.stop) {
      stop = { stop: step.stop, detail: step.detail };
      break;
    }
  }
  return report(model, 'repair', failing.length, counts, stop, deps);
}

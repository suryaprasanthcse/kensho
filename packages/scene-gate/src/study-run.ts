import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { runGenerations, runRepairs, type RunReport, type RunnerDeps } from './runner.ts';
import { STUDY_MODELS, STUDY_PARAMETERS, STUDY_TAG, STUDY_TAPES_PATH, SAMPLES_PER_PROMPT } from './study.ts';

/**
 * The study driver's core: what must be true before the first request, and the order the study runs in. The command
 * (scripts/run-study.ts) is a thin shell around this; every rule here is tested with a fake client and a fake git.
 */

export const PROMPT_FILES = ['prompts.json', 'system.md', 'repair.md'] as const;
export type PromptFile = (typeof PROMPT_FILES)[number];

/** The SHA-256 PREREGISTRATION.md records for each prompt file. Throws if one is missing. */
export function recordedHashes(preregistration: string): Record<PromptFile, string> {
  const out = {} as Record<PromptFile, string>;
  for (const file of PROMPT_FILES) {
    const row = new RegExp('\\| SHA-256 of `' + file.replace('.', '\\.') + '` \\| `([0-9a-f]{64})` \\|').exec(preregistration);
    if (!row) throw new Error(`PREREGISTRATION.md records no SHA-256 for ${file}`);
    out[file] = row[1]!;
  }
  return out;
}

export const sha256OfBytes = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** What the driver needs to know about the repository. */
export interface GitState {
  /** The commit HEAD points at. */
  head(): string;
  /** The commit a tag points at, or null when there is no such tag. */
  tagCommit(tag: string): string | null;
  /** Files that are modified, staged or untracked, other than anything under the tapes directory. */
  dirty(): string[];
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

/**
 * Reads the repository with git. The tapes directory is left out of the dirty check, because the study writes its tapes
 * into the repository: after the first tape, a check that counted them would refuse every restart.
 */
export function gitState(repoRoot: string, tapesPath: string = STUDY_TAPES_PATH): GitState {
  return {
    head: () => git(repoRoot, ['rev-parse', 'HEAD']),
    tagCommit: (tag) => {
      try {
        return git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]) || null;
      } catch {
        return null;
      }
    },
    dirty: () =>
      git(repoRoot, ['status', '--porcelain', '--untracked-files=all', '--', '.', `:(exclude)${tapesPath}`])
        .split('\n')
        .map((line) => line.trimEnd())
        .filter(Boolean),
  };
}

export interface PreflightInput {
  /** The text of PREREGISTRATION.md. */
  readonly preregistration: string;
  /** The bytes of the three prompt files. */
  readonly files: Readonly<Record<PromptFile, Buffer | string>>;
  readonly git: GitState;
  readonly tag?: string;
}

/**
 * Everything that must hold before the study sends a request. Returns the problems, all of them, so that one run shows
 * every reason; an empty list means the study may start.
 * - each prompt file hashes to what PREREGISTRATION.md records;
 * - the working tree is clean (the tapes directory aside);
 * - HEAD is the commit the frozen tag names.
 */
export function preflight(input: PreflightInput): string[] {
  const problems: string[] = [];
  const tag = input.tag ?? STUDY_TAG;

  let recorded: Record<PromptFile, string> | null = null;
  try {
    recorded = recordedHashes(input.preregistration);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (recorded) {
    for (const file of PROMPT_FILES) {
      const actual = sha256OfBytes(input.files[file]);
      if (actual !== recorded[file]) problems.push(`${file}: SHA-256 ${actual} does not match the ${recorded[file]} recorded in PREREGISTRATION.md`);
    }
  }

  const dirty = input.git.dirty();
  if (dirty.length) problems.push(`the working tree is not clean (${dirty.length} path${dirty.length === 1 ? '' : 's'}): ${dirty.slice(0, 10).join('; ')}${dirty.length > 10 ? '; ...' : ''}`);

  const head = input.git.head();
  const tagged = input.git.tagCommit(tag);
  if (tagged === null) problems.push(`there is no tag ${tag}, so there is no frozen commit to run from`);
  else if (head !== tagged) problems.push(`HEAD ${head} is not the commit tagged ${tag} (${tagged})`);
  return problems;
}

/** The `--tapes` argument, resolved from the directory the command was typed in. Only the study's tapes directory is accepted. */
export function resolveTapesArg(arg: string | undefined, startedIn: string, repoRoot: string): string {
  if (!arg) throw new Error('--tapes is required');
  const expected = resolve(repoRoot, STUDY_TAPES_PATH);
  if (relative(expected, resolve(startedIn, arg)) !== '') {
    throw new Error(`--tapes must be ${STUDY_TAPES_PATH}: the study writes its tapes nowhere else (got ${arg})`);
  }
  return expected;
}

export interface StudyConfig {
  readonly prompts: readonly { readonly id: string; readonly text: string }[];
  readonly system: string;
  /** The text of prompts/repair.md. */
  readonly template: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly deps: RunnerDeps;
  /** Defaults to the study's two models, in their fixed order. */
  readonly models?: readonly string[];
}

export interface StudyReport {
  readonly status: 'complete' | 'incomplete';
  readonly reports: readonly RunReport[];
  readonly spent_micro_usd: number;
}

/**
 * The study, in its fixed order, against the one ledger in `deps`:
 * 1. generation, model by model: 20 prompts x 3 samples each;
 * 2. then one repair round, model by model, for every generation whose verdict is `fail`.
 * Generation for both models comes before any repair, so that a spend cap that bites cuts the secondary measure and not
 * the primary one. A model whose transport failures pass 10% stops (and gets no repair round) while the other goes on.
 * A spend-cap stop or a rejected request ends the whole study. A request that already has a tape is skipped.
 */
export async function runStudy(config: StudyConfig): Promise<StudyReport> {
  const models = config.models ?? STUDY_MODELS;
  const reports: RunReport[] = [];
  const stopped = new Set<string>();
  let halted = false;

  for (const model of models) {
    if (halted) break;
    const report = await runGenerations({ model, parameters: STUDY_PARAMETERS, system: config.system, prompts: config.prompts, samples: SAMPLES_PER_PROMPT, jsonSchema: config.jsonSchema, deps: config.deps });
    reports.push(report);
    if (report.stopped === 'transport_failure_limit') stopped.add(model);
    else if (report.stopped) halted = true;
  }

  for (const model of models) {
    if (halted) break;
    if (stopped.has(model)) continue;
    const report = await runRepairs({ model, parameters: STUDY_PARAMETERS, system: config.system, template: config.template, prompts: config.prompts, jsonSchema: config.jsonSchema, deps: config.deps });
    reports.push(report);
    if (report.stopped) halted = true;
  }

  const complete = !halted && stopped.size === 0 && reports.every((r) => r.status === 'complete');
  return { status: complete ? 'complete' : 'incomplete', reports, spent_micro_usd: config.deps.ledger.spent };
}

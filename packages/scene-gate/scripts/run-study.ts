/**
 * Runs the study: 20 prompts x 3 runs x 2 models = 120 generations, then one repair round for every generation that
 * failed a check. This sends real requests and spends real money (hard stop at $10). Run it once, from the frozen commit:
 *
 *   pnpm --filter @kensho/scene-gate study --tapes packages/scene-gate/tapes
 *
 * It refuses to start unless every one of these holds, and says which does not:
 * - the SHA-256 of prompts/prompts.json, prompts/system.md and prompts/repair.md match PREREGISTRATION.md;
 * - the working tree is clean (the tapes directory aside);
 * - HEAD is the commit tagged scene-gate-prereg-v2.
 *
 * Tapes go to packages/scene-gate/tapes/<model>/<prompt_id>/<sample>.{generate,repair}.json, each with the commit hash.
 * A request that already has a tape is skipped, so an interrupted run is simply started again with the same command.
 * It prints one line per phase and model, never a key, a reply or an error body.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GeminiClient } from '../src/gemini-client.ts';
import { loadPrompts } from '../src/harness.ts';
import { sceneJsonSchema } from '../src/json-schema.ts';
import { SpendLedger } from '../src/spend.ts';
import { STUDY_TAG } from '../src/study.ts';
import { PROMPT_FILES, gitState, preflight, resolveTapesArg, runStudy, type PromptFile } from '../src/study-run.ts';
import { KEY_VARIABLES, findKey, loadEnv } from './smoke-schema.ts';

const PACKAGE = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(PACKAGE, '..', '..');

const dollars = (microUsd: number): string => `$${(microUsd / 1_000_000).toFixed(4)}`;

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { tapes: { type: 'string' } } });

  let tapeRoot: string;
  try {
    // pnpm runs the script from the package directory and keeps the directory the command was typed in in INIT_CWD.
    tapeRoot = resolveTapesArg(values.tapes, process.env.INIT_CWD ?? process.cwd(), REPO_ROOT);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\nusage: pnpm --filter @kensho/scene-gate study --tapes packages/scene-gate/tapes`);
    return 2;
  }

  const files = Object.fromEntries(PROMPT_FILES.map((f) => [f, readFileSync(resolve(PACKAGE, 'prompts', f))])) as Record<PromptFile, Buffer>;
  const git = gitState(REPO_ROOT);
  const problems = preflight({ preregistration: readFileSync(resolve(PACKAGE, 'PREREGISTRATION.md'), 'utf8'), files, git });
  if (problems.length) {
    console.error(`refusing to start the study (tag ${STUDY_TAG}):`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }

  const prompts = loadPrompts(resolve(PACKAGE, 'prompts', 'prompts.json')).prompts;
  if (prompts.length !== 20) {
    console.error(`prompts.json has ${prompts.length} prompts, the preregistration says 20`);
    return 1;
  }
  const apiKey = findKey(loadEnv(), KEY_VARIABLES.gemini);
  if (!apiKey) {
    console.error(`no Gemini key: set one of ${KEY_VARIABLES.gemini.join(', ')}`);
    return 2;
  }

  const commit = git.head();
  console.log(`study at commit ${commit}, tapes in ${tapeRoot}`);
  const report = await runStudy({
    prompts,
    system: files['system.md'].toString('utf8'),
    template: files['repair.md'].toString('utf8'),
    jsonSchema: sceneJsonSchema('gemini'),
    deps: {
      client: new GeminiClient({ apiKey }),
      tapeRoot,
      commit,
      ledger: new SpendLedger(),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: () => new Date(),
    },
  });
  for (const r of report.reports) {
    console.log(
      `${r.phase.padEnd(8)} ${r.model}: ${r.status}${r.stopped ? ` (stopped: ${r.stopped}${r.detail ? `, ${r.detail}` : ''})` : ''}; planned ${r.planned}, written ${r.written}, skipped ${r.skipped}, transport failures ${r.transport_failures}`,
    );
  }
  console.log(`study ${report.status}; ${dollars(report.spent_micro_usd)} counted against the $10 cap (retries and failed attempts included)`);
  return report.status === 'complete' ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixture, listFixtureIds, sha256, type Expected, type Fixture, type GateOptions } from './fixtures.ts';
import { SYNTHETIC_ORACLE_ID } from './provider.ts';

export interface LabelEntry {
  id: string;
  class: string;
  variant: 'default' | 'static';
  seed: number;
  control: boolean;
  file: string;
  bytes: number;
  sha256: string;
  options: GateOptions;
  expected: Expected;
}

export interface LabelsDocument {
  format: 'kensho-fixture-labels/1';
  generator: string;
  fixtures: LabelEntry[];
}

export const labelOf = (fx: Fixture): LabelEntry => ({
  id: fx.id,
  class: fx.klass,
  variant: fx.variant,
  seed: fx.seed,
  control: fx.control,
  file: `${fx.id}.glb`,
  bytes: fx.bytes.length,
  sha256: sha256(fx.bytes),
  options: fx.options,
  expected: fx.expected,
});

export const stringifyLabels = (doc: LabelsDocument): string => JSON.stringify(doc, null, 2) + '\n';

export interface GenerateResult {
  fixtures: Fixture[];
  document: LabelsDocument;
  /** Fixtures whose regenerated hash differs from the committed label (empty when no labels were given). */
  drift: { id: string; expected: string; actual: string }[];
}

/**
 * Regenerates every fixture, writing the GLBs to `outDir` (a gitignored folder). When `committed` is given,
 * reports every file whose SHA-256 no longer matches its committed label.
 */
export async function generateAll(outDir: string, committed?: LabelsDocument, ids: string[] = listFixtureIds()): Promise<GenerateResult> {
  mkdirSync(outDir, { recursive: true });
  const fixtures: Fixture[] = [];
  const entries: LabelEntry[] = [];
  const drift: GenerateResult['drift'] = [];
  const byId = new Map(committed?.fixtures.map((f) => [f.id, f]));
  for (const id of ids) {
    const fx = await buildFixture(id);
    writeFileSync(join(outDir, `${fx.id}.glb`), fx.bytes);
    const label = labelOf(fx);
    const old = byId.get(id);
    if (committed && (!old || old.sha256 !== label.sha256)) drift.push({ id, expected: old?.sha256 ?? '(no label)', actual: label.sha256 });
    fixtures.push(fx);
    entries.push(label);
  }
  return { fixtures, document: { format: 'kensho-fixture-labels/1', generator: SYNTHETIC_ORACLE_ID, fixtures: entries }, drift };
}

export const readLabels = (path: string): LabelsDocument => JSON.parse(readFileSync(path, 'utf8')) as LabelsDocument;

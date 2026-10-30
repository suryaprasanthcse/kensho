import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateAll, readLabels, stringifyLabels } from '@kensho/synthetic_oracle';
import { ASSET_DIR, LABELS_PATH } from './paths.ts';

const mode = process.argv[2] ?? 'verify';
if (mode !== 'write' && mode !== 'verify') {
  console.error('usage: pnpm fixtures [verify|write]');
  process.exit(3);
}

const committed = mode === 'verify' && existsSync(LABELS_PATH) ? readLabels(LABELS_PATH) : undefined;
if (mode === 'verify' && !committed) {
  console.error(`no labels at ${LABELS_PATH}; run "pnpm fixtures write" first`);
  process.exit(1);
}
const t0 = Date.now();
const { document, drift } = await generateAll(ASSET_DIR, committed);
if (mode === 'write') {
  mkdirSync(dirname(LABELS_PATH), { recursive: true });
  writeFileSync(LABELS_PATH, stringifyLabels(document));
  console.log(`wrote ${document.fixtures.length} labels to corpus/assets/labels.json`);
} else if (drift.length) {
  for (const d of drift) console.error(`hash drift ${d.id}: committed ${d.expected}, regenerated ${d.actual}`);
  process.exit(1);
} else {
  console.log(`regenerated ${document.fixtures.length} fixtures; every SHA-256 matches its committed label`);
}
console.log(`elapsed ${Date.now() - t0} ms`);

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sceneJsonSchema } from './schema.ts';

export const SCHEMA_PATH = resolve(import.meta.dirname, '../schema/scene-gate-1.json');

export const renderSchemaFile = (): string => JSON.stringify(sceneJsonSchema(), null, 2) + '\n';

if (import.meta.main) {
  mkdirSync(dirname(SCHEMA_PATH), { recursive: true });
  writeFileSync(SCHEMA_PATH, renderSchemaFile());
  console.log(`wrote ${SCHEMA_PATH}`);
}

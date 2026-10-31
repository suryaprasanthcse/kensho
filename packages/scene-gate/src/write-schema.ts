import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA_PROFILES, sceneJsonSchema, type SchemaProfile } from './json-schema.ts';

/** `full` is `scene-gate-1.json`; the provider profiles are `scene-gate-1.<profile>.json`. */
export const schemaPath = (profile: SchemaProfile): string =>
  resolve(import.meta.dirname, '../schema', profile === 'full' ? 'scene-gate-1.json' : `scene-gate-1.${profile}.json`);

export const renderSchemaFile = (profile: SchemaProfile): string => JSON.stringify(sceneJsonSchema(profile), null, 2) + '\n';

if (import.meta.main) {
  for (const profile of SCHEMA_PROFILES) {
    const path = schemaPath(profile);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderSchemaFile(profile));
    console.log(`wrote ${path}`);
  }
}

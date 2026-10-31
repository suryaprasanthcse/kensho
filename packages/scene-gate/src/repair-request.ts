import type { Diagnostic } from './diagnostic.ts';
import type { Scene } from './schema.ts';

/**
 * The repair request. Its system message is prompts/system.md, unchanged. Its user message is prompts/repair.md with
 * these three placeholders filled in. The reply is a corrected full scene under the same schema profile as a
 * generation; the patch is computed from it by `repairFromScene`.
 */
export const REPAIR_PLACEHOLDERS = ['{{prompt}}', '{{scene}}', '{{diagnostics}}'] as const;

/** The findings as the model sees them: code, pointer, message and evidence. Severity is left out. */
export const diagnosticsForModel = (diagnostics: readonly Diagnostic[]): string =>
  JSON.stringify(
    diagnostics.map(({ code, pointer, message, evidence }) => ({ code, pointer, message, evidence })),
    null,
    2,
  );

/** The scene as the model sees it: its own content, two-space indented so that every pointer can be followed by eye. */
export const sceneForModel = (scene: Scene): string => JSON.stringify(scene, null, 2);

export interface RepairInput {
  /** The original prompt text, verbatim. */
  readonly prompt: string;
  readonly scene: Scene;
  readonly diagnostics: readonly Diagnostic[];
}

/** Fills the template in a single pass, so text inside a substituted value is never treated as a placeholder. */
export function renderRepairMessage(template: string, input: RepairInput): string {
  const values: Record<string, string> = {
    prompt: input.prompt,
    scene: sceneForModel(input.scene),
    diagnostics: diagnosticsForModel(input.diagnostics),
  };
  return template.replace(/\{\{(prompt|scene|diagnostics)\}\}/g, (_match, key: string) => values[key]!);
}

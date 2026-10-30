export type Gate = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'BUNDLE';
export type Severity = 'error' | 'warning' | 'info';

export interface CodeInfo {
  readonly code: string;
  readonly gate: Gate;
  /** Severity when nothing else decides it (some codes are downgraded for static bodies). */
  readonly severity: Severity;
  readonly summary: string;
  /**
   * Fixture class ids that exercise this code. G4 ids are classes in corpus/assets/labels.json;
   * G6 and bundle ids are entries of the smoke catalogue. A code without a fixture does not ship.
   */
  readonly fixtures: readonly string[];
  /** The deterministic repair that would apply, when one exists. Descriptive only in this build. */
  readonly autofix?: string;
}

const def = (
  code: string,
  gate: Gate,
  severity: Severity,
  summary: string,
  fixtures: string[],
  autofix?: string,
): CodeInfo => ({ code, gate, severity, summary, fixtures, ...(autofix ? { autofix } : {}) });

const SHIPPED_LIST: CodeInfo[] = [
  // G4: asset gate
  def('GLTF_INVALID', 'G4', 'error', 'The file is not a valid glTF 2.0 asset per the Khronos validator, or cannot be parsed.', ['GLTF_INVALID']),
  def('TEXTURE_BUDGET', 'G4', 'error', 'A texture exceeds the tier maximum dimension, or the estimated GPU bytes exceed the tier budget.', ['TEXTURE_BUDGET'], 'resize textures to the tier maximum'),
  def('TRIANGLE_BUDGET', 'G4', 'error', 'Triangle count exceeds the tier and class budget.', ['TRIANGLE_BUDGET'], 'simplify'),
  def('PRIMITIVE_BUDGET', 'G4', 'error', 'Primitive (draw) count exceeds the tier and class budget.', ['PRIMITIVE_BUDGET'], 'merge primitives'),
  def('MATERIAL_BUDGET', 'G4', 'error', 'Distinct material count exceeds the tier and class budget.', ['MATERIAL_BUDGET'], 'merge materials'),
  def('NONFINITE_POSITION', 'G4', 'error', 'A vertex position contains NaN or an infinity.', ['NONFINITE_POSITION']),
  def('DEGENERATE_TRIANGLE', 'G4', 'error', 'The mesh contains zero-area triangles.', ['DEGENERATE_TRIANGLE'], 'drop degenerate triangles'),
  def('WINDING_INCONSISTENT', 'G4', 'error', 'Adjacent triangles disagree on winding order.', ['WINDING_INCONSISTENT']),
  def('NONMANIFOLD_EDGE', 'G4', 'error', 'An edge is shared by three or more triangles after weld. A warning for static bodies.', ['NONMANIFOLD_EDGE']),
  def('OPEN_BOUNDARY', 'G4', 'error', 'The surface has boundary edges after weld, so it is not closed. A warning for static bodies.', ['OPEN_BOUNDARY']),
  def('FLOATING_ISLANDS', 'G4', 'error', 'A small detached component holds a negligible share of the surface area.', ['FLOATING_ISLANDS'], 'drop the island'),
  def('BBOX_CONFORMANCE', 'G4', 'error', 'The asset aspect ratio does not match the declared box within tolerance.', ['BBOX_CONFORMANCE']),
  def('HULL_COMPLEXITY', 'G4', 'error', 'The collider source is too complex to derive a hull from without simplification first.', ['HULL_COMPLEXITY'], 'simplify before hull derivation'),
  // G6: render smoke
  def('SHADER_COMPILE', 'G6', 'error', 'A shader failed to compile or link.', ['probe:bad_shader']),
  def('CONTEXT_LOST', 'G6', 'error', 'The WebGL context was lost.', ['probe:lose_context']),
  def('BLANK_FRAME', 'G6', 'error', 'The rendered frame is uniform: the camera is inside geometry or nothing is visible.', ['wall']),
  def('DRAWCALL_BUDGET', 'G6', 'error', 'Draw calls per frame exceed the tier budget.', ['drawcalls']),
  def('PROGRAM_BUDGET', 'G6', 'error', 'Shader programs exceed the tier budget.', ['probe:many_programs']),
  def('TEXTURE_MEMORY_BUDGET', 'G6', 'error', 'Estimated texture memory for the whole world exceeds the tier budget.', ['texture_heavy']),
  def('GL_ERROR', 'G6', 'error', 'A WebGL call reported an error.', ['probe:gl_error']),
  def('PAGE_EXCEPTION', 'G6', 'error', 'The page threw an uncaught exception.', ['probe:page_exception']),
  def('LOAD_FAILED', 'G6', 'error', 'A request failed or returned an error status.', ['probe:failed_request']),
  // Bundle verification
  def('BUNDLE_UNSIGNED', 'BUNDLE', 'error', 'The bundle carries no signature.', ['unsigned']),
  def('BUNDLE_SIGNATURE_INVALID', 'BUNDLE', 'error', 'The signature does not verify under the trusted key.', ['wrong_key', 'tampered_manifest']),
  def('BUNDLE_TAMPERED', 'BUNDLE', 'error', 'A file in the bundle does not match the hash in the signed manifest.', ['tampered_asset']),
  def('BUNDLE_MALFORMED', 'BUNDLE', 'error', 'The manifest is missing, unparseable or violates its schema.', ['malformed']),
];

export const REGISTRY: Readonly<Record<string, CodeInfo>> = Object.freeze(
  Object.fromEntries(SHIPPED_LIST.map((c) => [c.code, c])),
);

/**
 * Codes the design names for gates this build does not implement. They have no fixture here, so they do
 * not ship: they cannot be emitted, and a test pins that.
 */
export const PLANNED_CODES: Readonly<Record<string, Gate>> = Object.freeze({
  NONFINITE: 'G0',
  UNRESOLVED_REF: 'G1',
  OBJECTIVE_COUNT: 'G1',
  RULE_CYCLE: 'G1',
  SPATIAL_OVERLAP: 'G2',
  UNSUPPORTED_DYNAMIC: 'G2',
  SPAWN_OBSTRUCTED: 'G2',
  GOAL_UNREACHABLE: 'G3',
  PROGRESSION_CYCLE: 'G3',
  SOFTLOCK_DROP: 'G3',
  ENERGY_BLOWUP: 'G5',
  TUNNELING: 'G5',
  NO_SETTLE: 'G5',
  OBJECTIVE_TIMEOUT: 'G7',
  SPAWN_DEATH: 'G7',
});

export type ShippedCode = string;

export const isShippedCode = (code: string): boolean => Object.hasOwn(REGISTRY, code);
export const isPlannedCode = (code: string): boolean => Object.hasOwn(PLANNED_CODES, code);
export const codesForGate = (gate: Gate): CodeInfo[] => SHIPPED_LIST.filter((c) => c.gate === gate);

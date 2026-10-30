import { makeDiagnostic, type Diagnostic } from '@kensho/diagnostics';
import type { Json } from '@kensho/ir';

export type Tier = 'mobile' | 'desktop';

const MIB = 1024 * 1024;

/** Per-world render budgets by tier (§4.3). */
export const RENDER_BUDGETS: Record<Tier, { drawCalls: number; programs: number; textureBytes: number }> = {
  mobile: { drawCalls: 150, programs: 24, textureBytes: 256 * MIB },
  desktop: { drawCalls: 400, programs: 48, textureBytes: 768 * MIB },
};

/** What the page reports. */
export interface PageProbe {
  renderer: string;
  framesRendered: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  textures: number;
  textureBytes: number;
  frame: { sha256: string; distinctColours: number };
  shaderErrors: { program: string; vertex: string; fragment: string }[];
  glErrors: number[];
  contextLost: number;
  contextRestored: number;
  loadErrors: string[];
  compileError: string | null;
}

/** What the driver of the page sees from outside. */
export interface OutsideProbe {
  pageErrors: string[];
  failedRequests: { url: string; reason: string }[];
  badResponses: { url: string; status: number }[];
}

export interface Evaluated {
  diagnostics: Diagnostic[];
  measures: { [key: string]: Json };
}

const GL_ERROR_NAMES: Record<number, string> = { 0x500: 'INVALID_ENUM', 0x501: 'INVALID_VALUE', 0x502: 'INVALID_OPERATION', 0x505: 'OUT_OF_MEMORY', 0x506: 'INVALID_FRAMEBUFFER_OPERATION', 0x9242: 'CONTEXT_LOST_WEBGL' };

/** A pure function from probes to diagnostics: every G6 code is decided here. */
export function evaluateProbes(page: PageProbe, outside: OutsideProbe, tier: Tier, testOnlyDisable: readonly string[] = []): Evaluated {
  const b = RENDER_BUDGETS[tier];
  const d: Diagnostic[] = [];
  const frameUniform = page.frame.distinctColours <= 1;

  if (page.shaderErrors.length) {
    d.push(makeDiagnostic('SHADER_COMPILE', { pointer: '', message: `${page.shaderErrors.length} shader program(s) failed to compile or link`, evidence: { programs: page.shaderErrors.length }, }));
  }
  if (page.contextLost > 0) {
    d.push(makeDiagnostic('CONTEXT_LOST', { pointer: '', message: 'the WebGL context was lost', evidence: { losses: page.contextLost, restored: page.contextRestored } }));
  }
  const glErrors = page.glErrors.filter((e) => e !== 0x9242 || page.contextLost === 0); // a lost context reports CONTEXT_LOST_WEBGL; it is already recorded
  if (glErrors.length) {
    d.push(makeDiagnostic('GL_ERROR', { pointer: '', message: `WebGL reported ${glErrors.length} error(s), first ${GL_ERROR_NAMES[glErrors[0]!] ?? glErrors[0]}`, evidence: { count: glErrors.length, first_code: glErrors[0]! } }));
  }
  if (outside.pageErrors.length) {
    d.push(makeDiagnostic('PAGE_EXCEPTION', { pointer: '', message: `${outside.pageErrors.length} uncaught exception(s): ${outside.pageErrors[0]!.slice(0, 120)}`, evidence: { count: outside.pageErrors.length } }));
  }
  const loadFailures = outside.failedRequests.length + outside.badResponses.length + page.loadErrors.length;
  if (loadFailures) {
    d.push(makeDiagnostic('LOAD_FAILED', { pointer: '', message: `${loadFailures} failed load(s)`, evidence: { failed_requests: outside.failedRequests.length, bad_responses: outside.badResponses.length, loader_errors: page.loadErrors.length } }));
  }
  if (page.drawCalls > b.drawCalls) {
    d.push(makeDiagnostic('DRAWCALL_BUDGET', { pointer: '', message: `${page.drawCalls} draw calls exceed the ${tier} budget of ${b.drawCalls}`, evidence: { draw_calls: page.drawCalls, budget: b.drawCalls } }));
  }
  if (page.programs > b.programs) {
    d.push(makeDiagnostic('PROGRAM_BUDGET', { pointer: '', message: `${page.programs} shader programs exceed the ${tier} budget of ${b.programs}`, evidence: { programs: page.programs, budget: b.programs } }));
  }
  if (page.textureBytes > b.textureBytes) {
    d.push(makeDiagnostic('TEXTURE_MEMORY_BUDGET', { pointer: '', message: `estimated ${page.textureBytes} texture bytes exceed the ${tier} budget of ${b.textureBytes}`, evidence: { bytes: page.textureBytes, budget_bytes: b.textureBytes, textures: page.textures } }));
  }
  if (frameUniform && page.contextLost === 0) {
    d.push(makeDiagnostic('BLANK_FRAME', { pointer: '', message: 'the rendered frame is one uniform colour: the camera is inside geometry, or nothing is visible', evidence: { distinct_colours: page.frame.distinctColours } }));
  }

  // test-only: drop a code's findings, as a broken rule would, so tests can prove the suite notices
  const kept = d.filter((x) => !testOnlyDisable.includes(x.code));
  return {
    diagnostics: kept,
    measures: {
      draw_calls: page.drawCalls,
      triangles: page.triangles,
      programs: page.programs,
      textures: page.textures,
      texture_bytes_estimated: page.textureBytes,
      frames_rendered: page.framesRendered,
      gl_errors: glErrors.length,
      shader_errors: page.shaderErrors.length,
      context_losses: page.contextLost,
      page_exceptions: outside.pageErrors.length,
      failed_loads: loadFailures,
      frame_uniform: frameUniform ? 1 : 0,
    },
  };
}

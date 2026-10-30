import { describe, expect, it } from 'vitest';
import { RENDER_BUDGETS, evaluateProbes, type OutsideProbe, type PageProbe } from '../src/evaluate.ts';

const clean = (): PageProbe => ({
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))',
  framesRendered: 6,
  drawCalls: 6,
  triangles: 1900,
  programs: 2,
  textures: 1,
  textureBytes: 5_592_406,
  frame: { sha256: 'a'.repeat(64), distinctColours: 4000 },
  shaderErrors: [],
  glErrors: [],
  contextLost: 0,
  contextRestored: 0,
  loadErrors: [],
  compileError: null,
});
const quiet = (): OutsideProbe => ({ pageErrors: [], failedRequests: [], badResponses: [] });
const codes = (p: PageProbe, o: OutsideProbe = quiet(), tier: 'mobile' | 'desktop' = 'mobile') => evaluateProbes(p, o, tier).diagnostics.map((d) => d.code);

/** Probe data that makes each G6 code fire, with the codes it is expected to produce. */
const FIRING: Record<string, () => [PageProbe, OutsideProbe]> = {
  SHADER_COMPILE: () => [{ ...clean(), shaderErrors: [{ program: 'p', vertex: '', fragment: 'ERROR: 0:1' }] }, quiet()],
  CONTEXT_LOST: () => [{ ...clean(), contextLost: 1 }, quiet()],
  GL_ERROR: () => [{ ...clean(), glErrors: [0x500] }, quiet()],
  PAGE_EXCEPTION: () => [clean(), { ...quiet(), pageErrors: ['Error: boom'] }],
  LOAD_FAILED: () => [clean(), { ...quiet(), badResponses: [{ url: '/bundle/assets/x.glb', status: 404 }] }],
  DRAWCALL_BUDGET: () => [{ ...clean(), drawCalls: 600 }, quiet()],
  PROGRAM_BUDGET: () => [{ ...clean(), programs: 60 }, quiet()],
  TEXTURE_MEMORY_BUDGET: () => [{ ...clean(), textureBytes: 400 * 1024 * 1024 }, quiet()],
  BLANK_FRAME: () => [{ ...clean(), frame: { sha256: 'b'.repeat(64), distinctColours: 1 } }, quiet()],
};

describe('G6 probe evaluation', () => {
  it('reports nothing for a clean world', () => {
    expect(codes(clean())).toEqual([]);
  });

  it.each(Object.keys(FIRING))('%s fires from its own probe', (code) => {
    const [p, o] = FIRING[code]!();
    expect(codes(p, o)).toContain(code);
  });

  it('draw call, program and texture budgets are inclusive and tiered', () => {
    for (const tier of ['mobile', 'desktop'] as const) {
      const b = RENDER_BUDGETS[tier];
      expect(codes({ ...clean(), drawCalls: b.drawCalls }, quiet(), tier)).toEqual([]);
      expect(codes({ ...clean(), drawCalls: b.drawCalls + 1 }, quiet(), tier)).toEqual(['DRAWCALL_BUDGET']);
      expect(codes({ ...clean(), programs: b.programs }, quiet(), tier)).toEqual([]);
      expect(codes({ ...clean(), programs: b.programs + 1 }, quiet(), tier)).toEqual(['PROGRAM_BUDGET']);
      expect(codes({ ...clean(), textureBytes: b.textureBytes }, quiet(), tier)).toEqual([]);
      expect(codes({ ...clean(), textureBytes: b.textureBytes + 1 }, quiet(), tier)).toEqual(['TEXTURE_MEMORY_BUDGET']);
    }
    expect(RENDER_BUDGETS.mobile.drawCalls).toBe(150);
    expect(RENDER_BUDGETS.desktop.drawCalls).toBe(400);
    expect(RENDER_BUDGETS.mobile.programs).toBe(24);
    expect(RENDER_BUDGETS.desktop.programs).toBe(48);
  });

  it('600 props fail on both tiers, 300 only on mobile', () => {
    expect(codes({ ...clean(), drawCalls: 600 }, quiet(), 'desktop')).toEqual(['DRAWCALL_BUDGET']);
    expect(codes({ ...clean(), drawCalls: 300 }, quiet(), 'desktop')).toEqual([]);
    expect(codes({ ...clean(), drawCalls: 300 }, quiet(), 'mobile')).toEqual(['DRAWCALL_BUDGET']);
  });

  it('a lost context is CONTEXT_LOST and is not also called a blank frame or a GL error', () => {
    const p = { ...clean(), contextLost: 1, glErrors: [0x9242], frame: { sha256: 'c'.repeat(64), distinctColours: 1 } };
    expect(codes(p)).toEqual(['CONTEXT_LOST']);
  });

  it('counts a failed request and a loader error together', () => {
    const r = evaluateProbes({ ...clean(), loadErrors: ['a0: boom'] }, { ...quiet(), failedRequests: [{ url: '/x', reason: 'net::ERR' }] }, 'mobile');
    expect(r.measures.failed_loads).toBe(2);
  });

  it('every measure is an integer, so the report can be hashed', () => {
    const [p, o] = FIRING.DRAWCALL_BUDGET!();
    for (const v of Object.values(evaluateProbes(p, o, 'mobile').measures)) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('gate mutation (G6): disabling a rule must be noticed', () => {
  it.each(Object.keys(FIRING))('with %s disabled the fixture for it no longer produces it', (code) => {
    const [p, o] = FIRING[code]!();
    const normal = evaluateProbes(p, o, 'mobile').diagnostics.map((d) => d.code);
    const broken = evaluateProbes(p, o, 'mobile', [code]).diagnostics.map((d) => d.code);
    expect(normal).toContain(code);
    expect(broken).not.toContain(code);
  });
});

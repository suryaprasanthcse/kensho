import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyPatch } from 'fast-json-patch';
import {
  PLANNED_CODES,
  REGISTRY,
  DiagnosticError,
  deriveVerdict,
  exitCodeFor,
  isJsonPointer,
  makeDiagnostic,
  pointerFrom,
  sortDiagnostics,
} from '../src/index.ts';

describe('registry', () => {
  it('ships only codes that name at least one fixture', () => {
    for (const info of Object.values(REGISTRY)) expect(info.fixtures.length, info.code).toBeGreaterThan(0);
  });

  it('keeps planned codes out of the registry and refuses to emit them', () => {
    for (const code of Object.keys(PLANNED_CODES)) {
      expect(REGISTRY[code]).toBeUndefined();
      expect(() => makeDiagnostic(code, { pointer: '', message: 'x' })).toThrowError(DiagnosticError);
    }
  });

  it('uses UPPER_SNAKE names with no duplicates across shipped and planned', () => {
    const all = [...Object.keys(REGISTRY), ...Object.keys(PLANNED_CODES)];
    expect(new Set(all).size).toBe(all.length);
    for (const c of all) expect(c).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});

describe('Diagnostic', () => {
  it('fills gate and severity from the registry', () => {
    const d = makeDiagnostic('TRIANGLE_BUDGET', { pointer: '/meshes', message: 'too many', evidence: { triangles: 9000, budget: 5000 } });
    expect(d).toMatchObject({ code: 'TRIANGLE_BUDGET', gate: 'G4', severity: 'error', pointer: '/meshes' });
  });

  it('accepts a valid RFC 6902 fix and applies it', () => {
    const fix = [{ op: 'replace' as const, path: '/a/b', value: 2 }];
    const d = makeDiagnostic('TEXTURE_BUDGET', { pointer: '/images/0', message: 'm', fix });
    expect(applyPatch({ a: { b: 1 } }, d.fix!).newDocument).toEqual({ a: { b: 2 } });
  });

  it('rejects a malformed fix and a malformed pointer', () => {
    expect(() => makeDiagnostic('TEXTURE_BUDGET', { pointer: '/x', message: 'm', fix: [{ op: 'bogus' } as never] })).toThrowError(DiagnosticError);
    expect(() => makeDiagnostic('TEXTURE_BUDGET', { pointer: 'no-slash', message: 'm' })).toThrowError(DiagnosticError);
    expect(() => makeDiagnostic('TEXTURE_BUDGET', { pointer: '/a~2', message: 'm' })).toThrowError(DiagnosticError);
  });

  it('property: pointerFrom always yields a valid RFC 6901 pointer', () => {
    fc.assert(fc.property(fc.array(fc.oneof(fc.string(), fc.nat()), { maxLength: 6 }), (toks) => isJsonPointer(pointerFrom(...toks))));
  });

  it('sorts deterministically with errors first', () => {
    const w = makeDiagnostic('OPEN_BOUNDARY', { pointer: '/b', message: 'w', severity: 'warning' });
    const e = makeDiagnostic('GLTF_INVALID', { pointer: '', message: 'e' });
    expect(sortDiagnostics([w, e]).map((d) => d.code)).toEqual(['GLTF_INVALID', 'OPEN_BOUNDARY']);
  });
});

describe('verdict', () => {
  const err = makeDiagnostic('GLTF_INVALID', { pointer: '', message: 'e' });
  it('FAIL beats ABSTAIN beats PASS', () => {
    expect(deriveVerdict([err], { a: { status: 'abstained' } })).toBe('FAIL');
    expect(deriveVerdict([], { a: { status: 'abstained' } })).toBe('ABSTAIN');
    expect(deriveVerdict([], { a: { status: 'ran' }, b: { status: 'not_checked' } })).toBe('PASS');
  });
  it('maps to the documented exit codes', () => {
    expect([exitCodeFor('PASS'), exitCodeFor('FAIL'), exitCodeFor('ABSTAIN')]).toEqual([0, 1, 2]);
  });
});

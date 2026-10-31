import { describe, expect, it } from 'vitest';
import { evaluateRaw, evaluateValue } from '../src/check.ts';
import { verdictOf } from '../src/verdict.ts';
import { EXAMPLE_SCENE, brief } from './fixtures.ts';

describe('the task example: schema-valid and unplayable', () => {
  const evaluation = evaluateRaw(JSON.stringify(EXAMPLE_SCENE));

  it('is schema-valid, so the semantic checks ran', () => {
    expect(evaluation.kind).toBe('checked');
  });

  it('produces exactly the two expected diagnostics, in pointer order', () => {
    expect(brief(evaluation.diagnostics)).toEqual(['UNRESOLVED_REF /entities/3/guards/0', 'OBJECTIVE_COUNT /objectives/0/count']);
    expect(evaluation.diagnostics.every((d) => d.severity === 'error')).toBe(true);
  });

  it('explains both in evidence', () => {
    const [ref, count] = evaluation.diagnostics;
    expect(ref!.evidence).toEqual({ ref: 'chest_1', reason: 'missing' });
    expect(count!.evidence).toEqual({ tag: 'coin', needed: 10, available: 1 });
  });

  it('fails', () => {
    expect(verdictOf(evaluation)).toBe('fail');
  });

  it('still produces exactly those two with the optional height check on', () => {
    expect(brief(evaluateValue(EXAMPLE_SCENE, { unreachableHeight: true }).diagnostics)).toEqual([
      'UNRESOLVED_REF /entities/3/guards/0',
      'OBJECTIVE_COUNT /objectives/0/count',
    ]);
  });
});

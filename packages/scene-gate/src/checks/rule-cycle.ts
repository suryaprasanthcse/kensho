import { diag, pointerFrom, type Diagnostic } from '../diagnostic.ts';
import type { Scene } from '../schema.ts';

/**
 * RULE_CYCLE: the on -> emit event graph has a cycle. Depth-first search in rule order; every rule whose emit event is
 * already on the search stack closes a cycle and is reported.
 */
export function checkRuleCycle(scene: Scene): Diagnostic[] {
  const rulesFrom = new Map<string, number[]>();
  scene.rules.forEach((r, i) => {
    const list = rulesFrom.get(r.on);
    if (list) list.push(i);
    else rulesFrom.set(r.on, [i]);
  });

  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const out: Diagnostic[] = [];

  const visit = (event: string): void => {
    state.set(event, 'open');
    stack.push(event);
    for (const ri of rulesFrom.get(event) ?? []) {
      const rule = scene.rules[ri]!;
      const next = rule.emit;
      const seen = state.get(next);
      if (seen === 'open') {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        out.push(diag('RULE_CYCLE', pointerFrom('rules', ri), `rule ${rule.id} closes an event cycle`, { rule: rule.id, cycle }));
      } else if (seen === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(event, 'done');
  };

  for (const r of scene.rules) if (!state.has(r.on)) visit(r.on);
  return out;
}

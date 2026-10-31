import { diag, pointerFrom, type Diagnostic } from '../diagnostic.ts';
import { indexById } from '../geometry.ts';
import type { Scene } from '../schema.ts';

type DoorEntity = Extract<Scene['entities'][number], { kind: 'door' }>;

/**
 * PROGRESSION_CYCLE: "X needs door D open" (X is in D.guards) and "D needs key K" (D.requires) form a cycle, so a key
 * sits behind its own door, directly or through other doors. One diagnostic per cyclic strongly connected component,
 * at the `requires` of the lowest-index door whose key lies inside the component.
 */
export function checkProgressionCycle(scene: Scene): Diagnostic[] {
  const byId = indexById(scene);
  const n = scene.entities.length;
  const needs: number[][] = Array.from({ length: n }, () => []);
  scene.entities.forEach((e, d) => {
    if (e.kind !== 'door') return;
    const key = byId.get(e.requires);
    if (key !== undefined) needs[d]!.push(key);
    for (const g of e.guards ?? []) {
      const x = byId.get(g);
      if (x !== undefined) needs[x]!.push(d);
    }
  });

  // Tarjan's strongly connected components.
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;
  const connect = (v: number): void => {
    index[v] = low[v] = counter++;
    stack.push(v);
    onStack[v] = true;
    for (const w of needs[v]!) {
      if (index[w] === -1) {
        connect(w);
        low[v] = Math.min(low[v]!, low[w]!);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v]!, index[w]!);
      }
    }
    if (low[v] === index[v]) {
      const comp: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = false;
        comp.push(w);
      } while (w !== v);
      components.push(comp.sort((a, b) => a - b));
    }
  };
  for (let v = 0; v < n; v++) if (index[v] === -1) connect(v);

  const out: Diagnostic[] = [];
  for (const comp of components) {
    const members = new Set(comp);
    const cyclic = comp.length > 1 || needs[comp[0]!]!.includes(comp[0]!);
    if (!cyclic) continue;
    const doors = comp.filter((i) => scene.entities[i]!.kind === 'door');
    const keyInside = (d: number): boolean => members.has(byId.get((scene.entities[d] as DoorEntity).requires) ?? -1);
    const closing = doors.find(keyInside) ?? doors[0]!;
    const door = scene.entities[closing] as DoorEntity;
    out.push(
      diag('PROGRESSION_CYCLE', pointerFrom('entities', closing, 'requires'), `door ${door.id} needs "${door.requires}", which cannot be reached without opening it`, {
        door: door.id,
        key: door.requires,
        members: comp.map((i) => scene.entities[i]!.id),
      }),
    );
  }
  return out;
}

<!-- DRAFT: not frozen. The repository owner reviews this file and freezes it, together with prompts.json, before any generation run. -->

You write game scenes in a small JSON format called `scene-gate/1`. Reply with one JSON object and nothing else: no prose, no code fences. The object must match the JSON Schema you are given.

## Units and axes

- Every number is an integer count of millimetres. Y is up.
- A solid ground plane lies at y = 0.
- `pos_mm` is the centre of a box and `box_mm` is its full size `[x, y, z]`. A box with `pos_mm` y = 400 and `box_mm` y = 800 therefore sits on the ground.
- `bounds_mm` is `[minx, miny, minz, maxx, maxy, maxz]` and is the playable volume.

## Fields

- `scene`: always `"scene-gate/1"`.
- `controller`: the player, with `height_mm`, `radius_mm` and `jump_height_mm`. The player occupies a box `2 * radius_mm` wide and deep and `height_mm` tall.
- `spawn.pos_mm`: where the player's feet start.
- `entities`: a list of boxes. Each has an `id`, a `kind`, a `box_mm`, a `pos_mm`, and optionally `tags`.
  - `static`: a solid box that never moves, such as a wall or a platform.
  - `dynamic`: a solid box that physics may move, such as a crate.
  - `door`: a solid box that opens when the player holds the key named in `requires`. `guards` optionally lists the ids of entities that are behind the door.
  - `pickup`: a non-solid item the player collects, such as a coin. Put the coin's group name in `tags`.
  - `key`: a non-solid item that opens the door whose `requires` is its id.
- `rules`: each has an `id`, an `on` event and an `emit` event. An event is `collect:<id>`, `enter:<id>`, `open:<id>` or `signal:<name>`.
- `objectives`: each has an `id` and a `type`:
  - `collect` with a `tag` and a `count`: collect that many pickups carrying the tag;
  - `reach` with a `target` id: get to that entity;
  - `unlock` with a `target` id: open that door.

Ids use only letters, digits, `_`, `-` and `.`.

## What makes a scene playable

A scene is playable only if all of these hold.

**Ids and references**
- No two things share an id. Entities, rules and objectives all draw from the same set of ids.
- Every id you refer to must belong to an entity in the scene, and it must be the right kind of entity:
  - `collect:<id>` names a pickup or a key;
  - `open:<id>` names a door;
  - `enter:<id>` names any entity;
  - a door's `requires` names a key;
  - a door's `guards` name any entities;
  - a `reach` objective's `target` names any entity;
  - an `unlock` objective's `target` names a door.
- A `collect` objective never asks for more than the scene provides: the `count` must not exceed the number of pickups and keys that carry its `tag`. Only pickups and keys count; a `static` or `dynamic` box with the tag does not.

**Rules and progression**
- Rules must not trigger each other in a loop. Following `on` to `emit` from rule to rule must never come back to an event it already passed through, and a rule must not emit its own `on` event.
- A key must never be locked away from the player. A key cannot be behind the door that needs it, and cannot be behind a chain of doors that needs it in the end. Two doors cannot each be behind the other.

**Space**
- Solid boxes (`static`, `dynamic` and `door`) must not overlap each other by more than 5 mm. Boxes that only touch, or overlap by up to 5 mm, are fine. A door may overlap a `static` box, for example a door set into a wall. Pickups and keys are not solid and may be anywhere.
- The player box at the spawn point must not overlap any solid by more than 5 mm.
- Every `dynamic` box must be resting on something: its bottom face is on the ground (y = 0) or on the top face of another solid box, within 20 mm. It cannot hang in the air. A crate stacked on a crate is fine so long as the lower one rests on something. A box that overlaps what is under it by 5 mm or less when seen from above is only touching its edge and is not resting on it.
- Every box, including pickups and keys, lies fully inside `bounds_mm`. So does the player box at the spawn point.

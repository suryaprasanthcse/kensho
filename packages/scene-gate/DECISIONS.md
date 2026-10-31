# Decisions

Where the specification was ambiguous I took the stricter reading and recorded it here. Each item says what was chosen and what the looser reading would have been, so any of them can be relaxed on purpose.

## Reuse of other packages

- **`@kensho/diagnostics`' `Diagnostic` is not reused.** It requires a `gate` from a closed set (`G0`..`G7`, `BUNDLE`), none of which means scene-gate. `makeDiagnostic` only builds codes in its registry, and adding codes means editing that package. Its `sortDiagnostics` orders by severity first and uses `localeCompare`, where the contract says pointer then code. Scene-gate defines the contract's own `Diagnostic` and imports only `isJsonPointer` and `pointerFrom` (RFC 6901) from that package.
- **`@kensho/repair` is not reused.** It is a placeholder (`export {}`), so it does not implement the acceptance rule. `src/repair.ts` implements it here. No other package was modified.

## Format and schema

- Ids, tags and signal names match `[A-Za-z0-9_.-]+`, at most 64 characters. An event must be `collect|enter|open|signal` + `:` + a name of that shape. Anything else is `schema_invalid`.
- Coordinates and sizes are capped at 1 km (1,000,000 mm), sizes are at least 1 mm, and entities, rules and objectives are capped at 500, 200 and 50. The cap keeps every squared distance an exact integer, and the entity cap bounds the pairwise checks. A scene beyond a cap is `schema_invalid`.
- Objects are closed (`additionalProperties: false`): an unknown key is `schema_invalid`. A door must have `requires`; no other kind may.
- `bounds_mm` is not required to have min below max. Inverted bounds make everything `OUT_OF_BOUNDS`.
- There are three JSON Schema exports (`pnpm --filter @kensho/scene-gate schema`), all with fixed-length arrays as `items` plus equal `minItems`/`maxItems` (never `prefixItems`) and unions as `anyOf` (never `oneOf`):
  - `schema/scene-gate-1.json` is the reference, with every constraint.
  - `schema/scene-gate-1.claude.json` drops what Claude's structured outputs reject (integer ranges, string lengths, `maxItems`, `minItems` above 1) and the unverified `$schema`, `$id` and `title`.
  - `schema/scene-gate-1.gemini.json` drops what Gemini's `responseJsonSchema` does not list (`pattern`, string lengths, `$schema`, `$id`) and writes `const` as a one-value `enum`.
  Each dropped constraint is written into the node's description, and the zod schema still enforces all of them afterwards, so an array of the wrong length, or a number out of range, is `schema_invalid` rather than a provider error. Sources and the exact keyword lists are in `src/json-schema.ts` and pinned by tests. The documentation was read, not exercised: no request was sent to either API, so a keyword the docs do not mention could still be rejected.

## Arithmetic

- Boxes are held as `2 * pos +/- size` ("half-millimetres"), so a box with odd sizes still has integer edges. Thresholds are compared as `HALF * tolerance`. Diagnostics that carry such a number name it `*_half_mm`.

## Checks

- **DUPLICATE_ID**: entities, rules and objectives share one id namespace, in the order entities, rules, objectives. The looser reading is one namespace per list.
- **UNRESOLVED_REF**: fires on a missing id and on an entity of the wrong kind, with evidence `{id, expected_kind, actual_kind}` (`actual_kind` is `"missing"` when no entity has the id). Both `on` and `emit` events are checked. `collect:` needs a pickup or key, `open:` a door, `enter:` any entity; a door's `requires` needs a key and its `guards` any entity; a `reach` target is any entity and an `unlock` target a door. `signal:` names are not ids and are not resolved. A `reach` target has no kind restriction because the format gives none, so a reach objective can be satisfied by pointing it at any entity. Duplicate ids resolve to the first entity.
- **OBJECTIVE_COUNT**: only `pickup` and `key` entities count towards a tag. A tagged `static` does not.
- **RULE_CYCLE**: depth-first search in rule order; every rule whose `emit` is already on the search stack is reported at `/rules/i`. Several cycles give several diagnostics. Which rule "closes" a cycle depends on that order, which is fixed.
- **PROGRESSION_CYCLE**: "X needs door D open" when X is in `D.guards`; "D needs key K" when `D.requires` is K. A cycle in that graph is a deadlock. This also covers two doors that each guard the other, which no key can break. One diagnostic per cyclic strongly connected component, at the `requires` of its lowest-index door whose key lies inside the component. References that do not resolve are left out of the graph (UNRESOLVED_REF reports them).
- **SPATIAL_OVERLAP**: every pair of solids is checked, so static against static is flagged, as are door against door and door against dynamic. Only door against static is exempt. The implicit ground is not part of the check: the specification lists "the ground" and "a solid top" as different things, so the ground is not a solid. A box sunk into the ground is therefore not diagnosed, except as `OUT_OF_BOUNDS` when `bounds_mm` starts at y = 0. One diagnostic per overlapping pair.
- **SPAWN_OBSTRUCTED**: one diagnostic per obstructing solid, all at `/spawn/pos_mm`. Same ground rule as above.
- **UNSUPPORTED_DYNAMIC**: a support is another solid whose footprint overlaps the box's footprint by more than 5 mm in both x and z, and whose top is not more than 5 mm above the box's bottom (a solid reaching higher overlaps the box and is not a floor under it). The ground, at y = 0, always supports. Stacked crates support each other; a floating stack reports only the lowest floating crate.
- **OUT_OF_BOUNDS**: zero tolerance; touching the bounds is inside. Every entity kind is checked, pickups included. The spawn is checked as the player box, not as a point.
- **UNREACHABLE_HEIGHT**: "needed" means a collectible whose tag some collect objective asks for, a reach or unlock target, or a key some door requires. An item's height is its bottom face. A step is a solid whose top is not above the item's top, with the straight-line distance from the item's centre to the step's footprint at most 1500 mm. The item is reachable if its bottom is within `jump_height_mm` of the ground or of the highest step. It is off by default and, when on, reports errors.
- All findings are `error` severity. `warning` exists in the contract, but no check uses it. A scene passes only if it has no error.

## Order and hashing

- Diagnostics sort by pointer, then code, compared as plain strings (UTF-16 code unit order, no locale). So `/entities/10` sorts before `/entities/2`. Ties then fall back to message, then canonical evidence, so equal pointers and codes still sort identically every time.
- The hash covers the whole diagnostic list, messages included. Messages are therefore part of the contract: changing one changes every hash.

## Raw output

- Parsing is strict. Code fences or prose around the JSON make the output `unparseable`, not silently stripped, because a scene the checks never saw is a failure of the generation.
- A parse failure is classified as `empty`, `refusal` (no `{` in the text, or the provider reported a refusal), `truncated` (the text ends inside an open string or bracket, or the provider reported a length stop) or `unparseable`. The provider's stop reason is used only when the text does not parse; text that parses is judged on its content. These classifications are heuristics.
- `SCHEMA_INVALID` is not one of the ten semantic codes. It is the diagnostic code of the `schema_invalid` verdict, and the statistics count it apart from `fail`.

## Repair

- A patch is refused if it removes an objective, lowers a collect count, changes a collect objective's tag, or changes any objective's type. A reach or unlock objective's target may change only if the old target was flagged `UNRESOLVED_REF` (missing or the wrong kind) in the scene as given, and only to an entity that exists in the patched scene and has the right kind (a door for unlock, any entity for reach). A valid target is never retargeted, even to an equally good entity, and even when the same patch fixes another objective. Whether a target was valid is judged before the patch, so a patch cannot break a target and then "repair" it. The new target is judged on the patched scene, so one patch can add an entity and retarget to it. A reach objective whose target is flagged can still be pointed at any entity, since reach has no kind restriction.
- "No new code appears" is judged over all severities. "Strictly shrinks" means a proper sub-multiset: no code occurs more often than before and at least one occurs less. A patch that clears one error but adds another instance of an existing code is refused as `not_shrinking`.
- A scene that is not schema-valid is not repairable, and a patch that leaves the scene schema-invalid is refused.

## Statistics

- The flip rate is over (prompt, model) groups that have exactly three verdicts. Groups with any other number are left out and counted as `incomplete`. A flip compares the verdict (`pass`, `fail`, `schema_invalid`), not the diagnostic hash: two different failing scenes are not a flip.
- The unplayable rate is `fail` divided by schema-valid scenes; `schema_invalid` outputs are reported next to it, not inside it.

## Prompts

- `system.md` states, in plain words and without diagnostic codes, every rule the default checks enforce, with their thresholds (5 mm and 20 mm). It does not mention the optional height rule, because that check is off by default; if a study run enables `--unreachable-height`, the prompt must be extended first. A test pins that no code name appears in it and that every default rule has a sentence. The study therefore measures whether a model follows stated rules, not whether it guesses them.

# @kensho/gates-asset

G4 asset gate: the Khronos glTF validator, triangle, primitive, material and texture budgets, topology after weld, box conformance and collider proxy derivation, producing one JSON report per asset.

Two rules are deliberately graded rather than binary, and both report the evidence they used:

- **Degenerate triangles.** Up to 0.5% of all triangles are pruned by an autofix and reported as a warning. The autofix must prove itself sound: the repaired file has none left, no new error code and unchanged topology, and its hash is in the report (`--write-fixed` writes it). Above 0.5%, or when the triangles are in a strip or fan, or when the repair cannot be proven, it is an error.
- **Minor shells.** A detached component under 1% of the surface area is a warning when it lies inside the convex hull of the main body, and an error when it lies outside. The distance outside is always reported, and the tolerance is 0.1% of the body extent.

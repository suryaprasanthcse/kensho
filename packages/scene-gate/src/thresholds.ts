/**
 * Thresholds in whole millimetres, as specified. Geometry is computed in half-millimetres (see geometry.ts) so
 * that boxes with odd sizes stay integral; `HALF` converts.
 */
export const OVERLAP_TOLERANCE_MM = 5;
export const SUPPORT_TOLERANCE_MM = 20;
/** UNREACHABLE_HEIGHT: how far from a needed item a solid top still counts as a step. */
export const STEP_RADIUS_MM = 1500;

/** Half-millimetres per millimetre. */
export const HALF = 2;

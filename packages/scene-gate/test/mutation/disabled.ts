import type { Diagnostic } from '../../src/diagnostic.ts';

/**
 * Stands in for one check module while it is "mutated": every check function is exported and finds nothing. The
 * vitest config in this folder aliases a single src/checks/<file>.ts to this file, so exactly that check is disabled.
 */
const disabled = (): Diagnostic[] => [];

export const checkDuplicateId = disabled;
export const checkUnresolvedRef = disabled;
export const checkObjectiveCount = disabled;
export const checkRuleCycle = disabled;
export const checkProgressionCycle = disabled;
export const checkSpatialOverlap = disabled;
export const checkSpawnObstructed = disabled;
export const checkUnsupportedDynamic = disabled;
export const checkOutOfBounds = disabled;
export const checkUnreachableHeight = disabled;

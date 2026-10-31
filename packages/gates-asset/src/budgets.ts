import type { AssetClass, Tier } from './types.ts';

type PerClass = Record<AssetClass, number>;

export interface Budgets {
  triangles: PerClass;
  /** Not in the design's budget table: this proof's own placeholders. */
  primitives: PerClass;
  /** Not in the design's budget table: this proof's own placeholders. */
  materials: PerClass;
  maxTextureDim: number;
  /** Estimated GPU bytes for one asset's textures. */
  textureBytes: number;
  hullVertices: number;
}

const MIB = 1024 * 1024;

/** Triangle, texture and hull values are the design's per-tier starting values (§4.3). */
export const BUDGETS: Record<Tier, Budgets> = {
  mobile: {
    triangles: { hero: 20_000, prop: 5_000, background: 1_500 },
    primitives: { hero: 16, prop: 8, background: 4 },
    materials: { hero: 8, prop: 4, background: 2 },
    maxTextureDim: 2048,
    textureBytes: 256 * MIB,
    hullVertices: 64,
  },
  desktop: {
    triangles: { hero: 60_000, prop: 15_000, background: 5_000 },
    primitives: { hero: 32, prop: 16, background: 8 },
    materials: { hero: 16, prop: 8, background: 4 },
    maxTextureDim: 4096,
    textureBytes: 768 * MIB,
    hullVertices: 128,
  },
};

/** Thresholds that are not per-tier. */
export const THRESHOLDS = {
  /** Vertices closer than this (after rounding to a grid of this size) weld together. */
  weldUm: 1,
  /** A triangle at or below this area is degenerate, in square micrometres (1e-10 m^2). */
  degenerateAreaUm2: 100,
  /**
   * Degenerate triangles up to this share of all triangles (0.5%) are pruned by the autofix and reported as a
   * warning; above it, or when they cannot be pruned, the asset is rejected.
   */
  degenerateAutofixPpm: 5_000,
  /** A detached component below this share of total area is a minor island. */
  islandSharePpm: 10_000,
  /**
   * A minor island whose vertices all lie inside the convex hull of the largest component, dilated by this
   * share of that component's extent (1%), is a decorative shell (warning): relief hardware such as brackets
   * and hinges stands just proud of the hull. Anything further out is debris (error). The distance outside is
   * always reported. The value was set after seeing that the frozen chest's brackets sit 0.12% outside, and a
   * freshly generated chest's up to 0.58%.
   */
  islandHullTolerancePpm: 10_000,
  /** The declared-box aspect tolerance. */
  boxAspectPpm: 150_000,
  /** Collider sources above this many triangles are refused before any hull work. */
  hullSourceTriangles: 60_000,
  /** Hull volume over bounding-box volume at or above which a box primitive fits. */
  boxFitPpm: 850_000,
  /** Hull vertex radius spread (over mean) at or below which a sphere primitive fits. */
  sphereFitPpm: 50_000,
  /** How far the hull-to-box volume ratio may stray from pi/6 for a sphere fit. */
  sphereFillTolPpm: 60_000,
} as const;

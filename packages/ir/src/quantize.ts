/** Conversions from floating-point measurements to the integers that may enter a hashed record. */

export const UM_PER_M = 1_000_000;
export const PPM = 1_000_000;

/** Metres to integer micrometres. */
export const metresToUm = (m: number): number => Math.round(m * UM_PER_M) + 0;

/** Integer micrometres back to metres, for rendering only. */
export const umToMetres = (um: number): number => um / UM_PER_M;

/** Radians to integer microradians. */
export const radToUrad = (r: number): number => Math.round(r * 1_000_000) + 0;

/** A ratio (for example 0.15) to integer parts per million. */
export const ratioToPpm = (r: number): number => Math.round(r * PPM) + 0;

/** Integer ratio a/b in ppm using integer arithmetic only (b > 0). */
export const ppmOf = (a: number, b: number): number => (b === 0 ? 0 : Math.round((a * PPM) / b) + 0);

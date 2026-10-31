/** JSON with object keys sorted at every depth. Only strings, integers, booleans, null, arrays and objects occur. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError(`canonicalJson: non-integer number ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort(compareCodeUnits);
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}

/** UTF-16 code unit order. Unlike localeCompare it does not depend on the ICU data of the runtime. */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

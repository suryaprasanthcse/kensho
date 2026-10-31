/** Why a model output never became a scene. These are reported next to, never inside, the semantic codes. */
export type InvalidReason = 'empty' | 'refusal' | 'truncated' | 'unparseable' | 'schema';

export type RawParse = { ok: true; value: unknown } | { ok: false; reason: Exclude<InvalidReason, 'schema'>; detail: string };

/** True when the text stops inside an open string, object or array: the shape of an output cut off by a token limit. */
export function endsUnterminated(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return inString || depth > 0;
}

const REFUSAL_REASONS: ReadonlySet<string> = new Set(['refusal', 'safety', 'prohibited_content', 'blocklist', 'spii', 'recitation']);

/**
 * Strict: the whole text must be one JSON document. Code fences or prose around it are unparseable, because a scene
 * the checks never saw is a failure of the generation, not something to be silently repaired.
 * `finishReason` only matters when parsing fails: a provider that says "refusal" or "length" names the cause. Gemini's
 * own reasons are understood as they are: `MAX_TOKENS` is a truncation, and `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST`,
 * `SPII`, `RECITATION` and a blocked prompt (`PROMPT_...`) are refusals.
 */
export function parseRawOutput(text: string, finishReason?: string | null): RawParse {
  if (text.trim() === '') return { ok: false, reason: 'empty', detail: 'the output is empty' };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stop = finishReason?.toLowerCase();
    if (stop && (REFUSAL_REASONS.has(stop) || stop.startsWith('prompt_'))) return { ok: false, reason: 'refusal', detail: `the model stopped on ${finishReason}` };
    if (stop === 'length' || stop === 'max_tokens') {
      return { ok: false, reason: 'truncated', detail: `the model stopped on ${finishReason}` };
    }
    if (!text.includes('{')) return { ok: false, reason: 'refusal', detail: 'the output contains no JSON object' };
    if (endsUnterminated(text)) return { ok: false, reason: 'truncated', detail: 'the output ends inside an open value' };
    return { ok: false, reason: 'unparseable', detail };
  }
}

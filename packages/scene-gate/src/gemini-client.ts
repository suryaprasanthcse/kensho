import { ProviderConfigError, type ModelResponse, type ProviderReply } from './transport.ts';
import type { GenerationRequest, ProviderClient, RepairRequest } from './harness.ts';

/**
 * The Gemini implementation of `ProviderClient`: one attempt per call, on `generateContent`, with the system text as
 * the system instruction, the prompt (or, for a repair, the rendered repair message) as the user message, and the
 * request's schema as `responseJsonSchema`. It owns no policy: timeouts, retries, backoff and the spend cap belong to
 * `requestWithRetries` (src/transport.ts), which calls this once per attempt.
 *
 * Only `max_output_tokens` is a study parameter, and it is the only one sent. Temperature, top-p, top-k, seed and
 * thinking are omitted so that the provider default applies; a request that carries any other parameter is a
 * configuration error, not something to retry.
 */
export interface GeminiFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
}
export type GeminiFetch = (url: string, init: GeminiFetchInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GeminiClientOptions {
  /** Never logged, never put in a URL or a body. */
  readonly apiKey: string;
  /** For tests. Defaults to the global `fetch`. */
  readonly fetch?: GeminiFetch;
  readonly baseUrl?: string;
}

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

type Json = Record<string, any>;

/** What a request sends in `generationConfig`, from the study parameters. */
export function generationLimits(parameters: GenerationRequest['parameters']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(parameters)) {
    if (name === 'max_output_tokens' && typeof value === 'number' && Number.isInteger(value) && value > 0) out.maxOutputTokens = value;
    else throw new ProviderConfigError(`parameter ${name} is not sent: the study sets only max_output_tokens and leaves the rest at the provider default`);
  }
  return out;
}

export function geminiBody(request: GenerationRequest, userText: string): unknown {
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: request.jsonSchema, ...generationLimits(request.parameters) },
  };
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** The reply text, the finish reason and the usage, as the tape records them. Thought parts, if any are returned, are not part of the reply. */
export function toModelResponse(json: unknown): ModelResponse {
  const body = (typeof json === 'object' && json !== null ? json : {}) as Json;
  const candidate = Array.isArray(body.candidates) ? (body.candidates[0] as Json | undefined) : undefined;
  const parts: Json[] = Array.isArray(candidate?.content?.parts) ? candidate!.content.parts : [];
  const rawOutput = parts.filter((p) => typeof p?.text === 'string' && p.thought !== true).map((p) => p.text as string).join('');
  const blocked = typeof body.promptFeedback?.blockReason === 'string' ? `PROMPT_${body.promptFeedback.blockReason}` : null;
  const finishReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : blocked;
  const meta = body.usageMetadata as Json | undefined;
  const usage = meta && typeof meta === 'object'
    ? {
        promptTokenCount: count(meta.promptTokenCount),
        candidatesTokenCount: count(meta.candidatesTokenCount),
        thoughtsTokenCount: count(meta.thoughtsTokenCount),
        totalTokenCount: count(meta.totalTokenCount),
      }
    : undefined;
  return { rawOutput, finishReason, ...(usage ? { usage } : {}) };
}

export class GeminiClient implements ProviderClient {
  readonly #apiKey: string;
  readonly #fetch: GeminiFetch;
  readonly #baseUrl: string;

  constructor(options: GeminiClientOptions) {
    if (!options.apiKey) throw new ProviderConfigError('an API key is required');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? (fetch as unknown as GeminiFetch);
    this.#baseUrl = options.baseUrl ?? BASE_URL;
  }

  generate(request: GenerationRequest, timeoutMs: number): Promise<ProviderReply> {
    return this.#attempt(request, request.prompt.text, timeoutMs);
  }

  repair(request: RepairRequest, timeoutMs: number): Promise<ProviderReply> {
    return this.#attempt(request, request.message, timeoutMs);
  }

  async #attempt(request: GenerationRequest, userText: string, timeoutMs: number): Promise<ProviderReply> {
    const body = JSON.stringify(geminiBody(request, userText));
    const url = `${this.#baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`;
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#apiKey },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Only the status of a failed attempt is kept; its body is never read.
    if (!response.ok) return { status: response.status };
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      // A body that is not JSON is a reply that did not arrive intact. A timeout or abort while reading is not caught here.
      if (error instanceof SyntaxError) return { status: response.status };
      throw error;
    }
    return { status: response.status, response: toModelResponse(json) };
  }
}

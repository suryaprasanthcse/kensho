/**
 * Values fixed by PREREGISTRATION.md that code needs. A test ties each of them to the text of the preregistration, so the
 * two cannot drift apart.
 */
export const STUDY_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'] as const;

/** Runs per prompt and model. */
export const SAMPLES_PER_PROMPT = 3;

/**
 * The only generation limit that is set. Gemini counts thinking tokens against it (https://ai.google.dev/gemini-api/docs/thinking,
 * read 2026-11-01: the limit "sets the maximum number of tokens a response can generate, including thought tokens").
 * Temperature, top-p, top-k, seed and thinking are not parameters of the study: they are omitted, so the provider default applies.
 */
export const STUDY_MAX_OUTPUT_TOKENS = 16_384;
export const STUDY_PARAMETERS = { max_output_tokens: STUDY_MAX_OUTPUT_TOKENS } as const;

/** The tag that names the frozen commit. A commit cannot contain its own hash, so PREREGISTRATION.md names the tag. */
export const STUDY_TAG = 'scene-gate-prereg-v2';

/** Where the study's tapes are written, relative to the repository root. */
export const STUDY_TAPES_PATH = 'packages/scene-gate/tapes';

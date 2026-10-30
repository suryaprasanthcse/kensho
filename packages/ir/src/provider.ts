/** The asset provider interface. Every provider other than the synthetic oracle is a stub. */

export type AssetClassName = 'hero' | 'prop' | 'background';

export interface AssetRequest {
  /** Provider-specific parameters. Their digest travels in every record. */
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly prompt: string;
  readonly assetClass: AssetClassName;
  readonly seed: number;
}

export interface JobRef {
  readonly providerId: string;
  /** Idempotency key: the hash of the request. */
  readonly key: string;
}

export type JobState = { readonly status: 'pending' | 'done' | 'failed'; readonly detail?: string };

export interface RawAsset {
  readonly bytes: Uint8Array;
  readonly providerId: string;
  readonly paramsDigest: string;
  /** Credits consumed. Always 0 for offline providers. */
  readonly consumed: number;
}

export interface AssetProvider {
  readonly id: string;
  submit(req: AssetRequest): Promise<JobRef>;
  poll(job: JobRef): Promise<JobState>;
  fetch(job: JobRef): Promise<RawAsset>;
}

export class NotConfiguredError extends Error {
  readonly code = 'NOT_CONFIGURED' as const;
  readonly providerId: string;
  constructor(providerId: string) {
    super(`NOT_CONFIGURED: provider "${providerId}" is a stub in this build`);
    this.name = 'NotConfiguredError';
    this.providerId = providerId;
  }
}

/** A typed stub: every method throws NOT_CONFIGURED and nothing touches the network. */
export function notConfiguredProvider(id: string): AssetProvider {
  const fail = (): never => {
    throw new NotConfiguredError(id);
  };
  return {
    id,
    submit: async () => fail(),
    poll: async () => fail(),
    fetch: async () => fail(),
  };
}

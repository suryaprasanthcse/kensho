export type Hyper3dErrorCode =
  | 'INVALID_REQUEST'
  | 'LIVE_DISABLED'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'PARALLELISM_LIMIT'
  | 'INSUFFICIENT_FUNDS'
  | 'CONTENT_VIOLATION'
  | 'JOB_REJECTED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'SUBMIT_UNKNOWN'
  | 'TIER_DOWNGRADE'
  | 'PRICE_DRIFT'
  | 'HALTED'
  | 'CREDIT_CEILING'
  | 'JOB_FAILED'
  | 'JOB_DEADLINE'
  | 'TRUNCATED_DOWNLOAD'
  | 'CORRUPT_DOWNLOAD'
  | 'PROTOCOL'
  | 'UNKNOWN_JOB'
  | 'NOT_READY';

export class Hyper3dError extends Error {
  readonly code: Hyper3dErrorCode;
  /** True when the request may have reached the provider and been charged. Never retried blindly. */
  readonly ambiguous: boolean;
  constructor(code: Hyper3dErrorCode, message: string, opts: { ambiguous?: boolean } = {}) {
    super(`${code}: ${message}`);
    this.name = 'Hyper3dError';
    this.code = code;
    this.ambiguous = opts.ambiguous ?? false;
  }
}

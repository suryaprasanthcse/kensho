declare module 'gltf-validator' {
  export interface ValidatorMessage {
    code: string;
    message: string;
    severity: 0 | 1 | 2 | 3;
    pointer?: string;
    offset?: number;
  }
  export interface ValidatorReport {
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      numHints: number;
      messages: ValidatorMessage[];
      truncated: boolean;
    };
  }
  const validator: {
    version(): string;
    validateBytes(data: Uint8Array, options?: { uri?: string; maxIssues?: number; ignoredIssues?: string[] }): Promise<ValidatorReport>;
  };
  export default validator;
}

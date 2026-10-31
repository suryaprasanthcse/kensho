import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type LedgerEvent = 'accepted' | 'rejected' | 'submit_unknown' | 'failed' | 'downloaded' | 'drift' | 'halted';

/** One line of the append-only ledger. Credits are integers in thousandths. The API key is never written. */
export interface LedgerEntry {
  v: 1;
  at: string;
  event: LedgerEvent;
  provider: string;
  key: string;
  uuid?: string;
  subscription_key?: string;
  seed?: number;
  tier?: string;
  params_digest?: string;
  consumed_mc?: number;
  expected_mc?: number;
  sha256?: string;
  bytes?: number;
  note?: string;
}

/**
 * An append-only JSONL file. Entries are written synchronously, so a billable job is on disk the moment it
 * is accepted and an interrupted run resumes without paying twice.
 */
export class Ledger {
  corruptLines = 0;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: LedgerEntry): void {
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
  }

  entries(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    const out: LedgerEntry[] = [];
    this.corruptLines = 0;
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LedgerEntry);
      } catch {
        this.corruptLines++; // a torn final line from a crash
      }
    }
    return out;
  }

  /** The accepted entry for a request key, unless that job has since failed. */
  accepted(key: string): LedgerEntry | undefined {
    const all = this.entries().filter((e) => e.key === key);
    const acc = all.find((e) => e.event === 'accepted');
    return acc && !all.some((e) => e.event === 'failed') ? acc : undefined;
  }

  /** Credits charged so far, in thousandths. */
  spentMillicredits(): number {
    return this.entries().filter((e) => e.event === 'accepted').reduce((n, e) => n + (e.consumed_mc ?? e.expected_mc ?? 0), 0);
  }
}

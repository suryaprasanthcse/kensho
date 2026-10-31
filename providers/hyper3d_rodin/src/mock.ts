import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** A GLB that passes the container check: header, one JSON chunk, no binary chunk. */
export function minimalGlb(tag = ''): Uint8Array {
  let json = JSON.stringify({ asset: { version: '2.0', generator: `mock${tag}` } });
  while (Buffer.byteLength(json) % 4) json += ' ';
  const body = Buffer.from(json);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + body.length, 8);
  head.writeUInt32LE(body.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return new Uint8Array(Buffer.concat([head, body]));
}

export type MockFault =
  | { kind: 'stall' }
  | { kind: 'drop' }
  | { kind: 'http'; status: number; body?: unknown; headers?: Record<string, string> }
  /** HTTP 201 whose body carries a non-empty `error`, as the real API does. */
  | { kind: 'api-error'; error: string }
  /** A normal success whose body is patched, for example to report a different tier or `consumed`. */
  | { kind: 'patch'; patch: Record<string, unknown> };

export type FileFault = 'truncate-silent' | 'cut-socket' | 'corrupt';

export interface MockOptions {
  /** The key the mock accepts. */
  apiKey?: string;
  /** How many status polls before a job reports Done. */
  pollsToDone?: number;
  /** Credits reported for an accepted job. */
  consumed?: number | ((fields: Record<string, string>) => number);
  /** Echo the requested tier in the submit response. */
  echoTier?: boolean;
  /** The provider's own parallelism cap: submits beyond it answer API_PARALLELISM_LIMIT_REACHED. */
  parallelismCap?: number;
  /** How many sub-jobs one submission fans out into (the live API returns three). */
  subJobs?: number;
  /** Job numbers (1-based) that end in Failed. */
  failJobs?: number[];
  glb?: Uint8Array;
  faults?: {
    submit?: (n: number, fields: Record<string, string[]>) => MockFault | undefined;
    status?: (n: number) => MockFault | undefined;
    download?: (n: number) => MockFault | undefined;
    file?: (n: number) => FileFault | undefined;
  };
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  fields?: Record<string, string[]>;
}

export interface MockServer {
  url: string;
  baseUrl: string;
  requests: RecordedRequest[];
  counts: { submit: number; status: number; download: number; file: number };
  /** Highest number of jobs that were accepted and not yet Done at the same moment. */
  peakRunning: () => number;
  accepted: () => number;
  close(): Promise<void>;
}

/** A local stand-in for the Rodin API. It never leaves loopback and spends nothing. */
export async function startMockRodin(options: MockOptions = {}): Promise<MockServer> {
  const o = { apiKey: 'test-key', pollsToDone: 2, subJobs: 3, consumed: 0.5, echoTier: true, glb: minimalGlb(), ...options };
  const requests: RecordedRequest[] = [];
  const counts = { submit: 0, status: 0, download: 0, file: 0 };
  const held = new Set<ServerResponse>();
  const jobs = new Map<string, { n: number; sub: string; polls: number; running: boolean; complete: boolean }>();
  const subToUuid = new Map<string, string>();
  let running = 0;
  let peak = 0;
  let acceptedCount = 0;

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(text);
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  const applyFault = (res: ServerResponse, f: MockFault | undefined): 'handled' | MockFault | undefined => {
    if (!f) return undefined;
    if (f.kind === 'stall') {
      held.add(res);
      res.on('close', () => held.delete(res));
      return 'handled';
    }
    if (f.kind === 'drop') {
      res.destroy();
      return 'handled';
    }
    if (f.kind === 'http') {
      send(res, f.status, f.body ?? { error: `HTTP ${f.status}` }, f.headers);
      return 'handled';
    }
    if (f.kind === 'api-error') {
      send(res, 201, { error: f.error, message: f.error });
      return 'handled';
    }
    return f;
  };

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const authorization = req.headers.authorization;
    const rec: RecordedRequest = { method: req.method ?? 'GET', path, authorization };
    requests.push(rec);
    try {
      if (path.startsWith('/files/')) {
        const n = ++counts.file;
        const fault = o.faults?.file?.(n);
        const full = Buffer.from(o.glb);
        if (fault === 'cut-socket') {
          res.writeHead(200, { 'content-length': String(full.length) });
          res.write(full.subarray(0, Math.floor(full.length / 2)));
          setTimeout(() => res.destroy(), 5);
          return;
        }
        if (fault === 'truncate-silent') {
          const part = full.subarray(0, Math.floor(full.length / 2));
          res.writeHead(200, { 'content-length': String(part.length) });
          res.end(part);
          return;
        }
        if (fault === 'corrupt') {
          const bad = Buffer.from(full);
          bad[0] ^= 0xff;
          res.writeHead(200, { 'content-length': String(bad.length) });
          res.end(bad);
          return;
        }
        res.writeHead(200, { 'content-length': String(full.length) });
        res.end(full);
        return;
      }
      if (authorization !== `Bearer ${o.apiKey}`) return send(res, 401, { error: 'UNAUTHORIZED' });
      const raw = await readBody(req);

      if (path === '/rodin' && req.method === 'POST') {
        const form = await new Response(new Uint8Array(raw), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData();
        const fields: Record<string, string[]> = {};
        for (const [k, v] of form.entries()) (fields[k] ??= []).push(String(v));
        rec.fields = fields;
        const n = ++counts.submit;
        const handled = applyFault(res, o.faults?.submit?.(n, fields));
        if (handled === 'handled') return;
        if (o.parallelismCap !== undefined && running >= o.parallelismCap) return send(res, 201, { error: 'API_PARALLELISM_LIMIT_REACHED' });
        acceptedCount++;
        const uuid = `job-${acceptedCount}`;
        const sub = `sub-${acceptedCount}`;
        jobs.set(uuid, { n: acceptedCount, sub, polls: 0, running: true, complete: false });
        subToUuid.set(sub, uuid);
        running++;
        peak = Math.max(peak, running);
        const consumed = typeof o.consumed === 'function' ? o.consumed(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v[0]!]))) : o.consumed;
        const body: Record<string, unknown> = { uuid, jobs: { uuids: Array.from({ length: o.subJobs }, (_, i) => `${uuid}-part-${i + 1}`), subscription_key: sub }, consumed, ...(o.echoTier ? { tier: fields.tier?.[0] } : {}) };
        return send(res, 201, handled && typeof handled === 'object' && handled.kind === 'patch' ? { ...body, ...handled.patch } : body);
      }

      if (path === '/status' && req.method === 'POST') {
        counts.status++;
        const handled = applyFault(res, o.faults?.status?.(counts.status));
        if (handled === 'handled') return;
        const uuid = subToUuid.get((JSON.parse(raw.toString('utf8')) as { subscription_key?: string }).subscription_key ?? '');
        const job = uuid ? jobs.get(uuid) : undefined;
        if (!uuid || !job) return send(res, 400, { error: 'API_OBJECT_NOT_FOUND' });
        job.polls++;
        // the sub-jobs finish one after another, as they do on the live API
        const parts = Array.from({ length: o.subJobs }, (_, i) => {
          const failing = o.failJobs?.includes(job.n) && i === o.subJobs - 1 && job.polls >= o.pollsToDone + i;
          const status = failing ? 'Failed' : job.polls >= o.pollsToDone + i ? 'Done' : job.polls >= i + 1 ? 'Generating' : 'Waiting';
          return { uuid: `${uuid}-part-${i + 1}`, status };
        });
        const finished = parts.every((p) => p.status === 'Done' || p.status === 'Failed');
        job.complete = parts.every((p) => p.status === 'Done');
        if (finished && job.running) {
          job.running = false;
          running--;
        }
        return send(res, 201, { jobs: parts });
      }

      if (path === '/download' && req.method === 'POST') {
        counts.download++;
        const handled = applyFault(res, o.faults?.download?.(counts.download));
        if (handled === 'handled') return;
        const uuid = (JSON.parse(raw.toString('utf8')) as { task_uuid?: string }).task_uuid;
        if (!uuid || !jobs.has(uuid)) return send(res, 400, { error: 'API_OBJECT_NOT_FOUND' });
        if (!jobs.get(uuid)!.complete) return send(res, 201, { list: [] }); // the live API does not refuse an unfinished task
        return send(res, 201, { list: [{ name: `${uuid}.glb`, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/files/${uuid}.glb` }] });
      }
      return send(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      send(res, 500, { error: String((e as Error).message) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    counts,
    peakRunning: () => peak,
    accepted: () => acceptedCount,
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of held) r.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

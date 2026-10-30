import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const THREE_ROOT = join(dirname(createRequire(import.meta.url).resolve('three')), '..');
export const THREE_VERSION: string = (JSON.parse(readFileSync(join(THREE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const RUNNER = readFileSync(fileURLToPath(new URL('./page/runner.js', import.meta.url)));

const PAGE = (query: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>kensho smoke</title>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
</head><body style="margin:0;background:#000"><script type="module" src="/runner.js${query}"></script></body></html>`;

export interface ServerOptions {
  manifest: Uint8Array;
  /** Manifest-relative path (`assets/<sha>.glb`) to the verified file on disk. */
  assets: ReadonlyMap<string, string>;
  /** Test-only hooks that change what the server does: `stall`, `failed_request`. */
  hooks: ReadonlySet<string>;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

const THREE_ALLOWED = /^\/three\/(build\/[A-Za-z0-9_.-]+\.js|examples\/jsm\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js)$/;

/**
 * Serves one verified bundle and three's own files on 127.0.0.1 at a random port. Only the manifest, the
 * assets it lists and an allow-list of three's JavaScript are ever served.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const held = new Set<ServerResponse>();
  let failedOnce = false;
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const send = (status: number, type: string, body: Uint8Array | string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
    if (req.method !== 'GET') return send(405, 'text/plain', 'method not allowed');
    if (path === '/') return send(200, 'text/html; charset=utf-8', PAGE(new URL(req.url!, 'http://x').search));
    if (path === '/runner.js') return send(200, 'text/javascript; charset=utf-8', RUNNER);
    if (path === '/favicon.ico') return send(204, 'image/x-icon', '');
    if (path === '/bundle/manifest.json') return send(200, 'application/json', opts.manifest);
    if (path.startsWith('/bundle/')) {
      const file = opts.assets.get(path.slice('/bundle/'.length));
      if (!file) return send(404, 'text/plain', 'not in the manifest');
      if (opts.hooks.has('stall')) {
        held.add(res); // never answered: a load that stalls
        res.on('close', () => held.delete(res));
        return;
      }
      if (opts.hooks.has('failed_request') && !failedOnce) {
        failedOnce = true;
        return send(404, 'text/plain', 'test hook: failed request');
      }
      return send(200, 'model/gltf-binary', readFileSync(file));
    }
    if (THREE_ALLOWED.test(path)) {
      try {
        return send(200, 'text/javascript; charset=utf-8', readFileSync(join(THREE_ROOT, path.slice('/three/'.length))));
      } catch {
        return send(404, 'text/plain', 'not found');
      }
    }
    return send(404, 'text/plain', 'not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server has no address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of held) r.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

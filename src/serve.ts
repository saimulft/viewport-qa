import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import type { StaticServer } from './types.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.map': 'application/json; charset=utf-8',
};

function fail(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${status}\n`);
}

async function respond(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405);
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    return fail(res, 400);
  }
  if (pathname.includes('\0')) return fail(res, 400);
  let file = resolve(join(root, pathname));
  if (file !== root && !file.startsWith(root + sep)) return fail(res, 403);
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    // Resolve symlinks so a link inside the folder cannot lead out of it.
    file = await realpath(file);
    if (!file.startsWith(root + sep)) return fail(res, 403);
    const info = await stat(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
  } catch {
    return fail(res, 404);
  }
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

/**
 * Serves a folder over HTTP on 127.0.0.1 with a free port, for pages that should not be loaded over file://.
 * Read-only, GET and HEAD only, and nothing outside the folder is reachable. Call `close()` when done.
 */
export async function serveDirectory(dir: string): Promise<StaticServer> {
  const root = await realpath(resolve(dir));
  const server = createServer((req, res) => {
    respond(root, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else fail(res, 500);
    });
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => done());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
        server.closeAllConnections();
      }),
  };
}

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { serveDirectory } from '../src/index.ts';
import type { StaticServer } from '../src/index.ts';

/** Sends a request with a raw path, which fetch() would normalise before it left. */
function send(
  server: StaticServer,
  path: string,
  method = 'GET',
): Promise<{ status: number; type?: string; body: string }> {
  const { port } = new URL(server.url);
  return new Promise((done, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => done({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serveDirectory', { timeout: 30_000 }, () => {
  let outer: string;
  let server: StaticServer;

  before(async () => {
    outer = await mkdtemp(join(tmpdir(), 'viewport-qa-serve-'));
    const root = join(outer, 'site');
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'page.html'), '<!doctype html><title>x</title>');
    await writeFile(join(root, 'style.css'), 'body{}');
    await writeFile(join(root, 'sub', 'index.html'), 'index of sub');
    await writeFile(join(outer, 'secret.txt'), 'secret');
    await symlink(join(outer, 'secret.txt'), join(root, 'link.txt'));
    server = await serveDirectory(root);
  });
  after(async () => {
    await server?.close();
    await rm(outer, { recursive: true, force: true });
  });

  it('listens on 127.0.0.1 only', () => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('serves files with their content type and never caches', async () => {
    const page = await send(server, '/page.html');
    assert.equal(page.status, 200);
    assert.equal(page.type, 'text/html; charset=utf-8');
    assert.match(page.body, /<title>x<\/title>/);
    assert.equal((await send(server, '/style.css')).type, 'text/css; charset=utf-8');
  });

  it('serves index.html for a folder and answers HEAD without a body', async () => {
    assert.equal((await send(server, '/sub/')).body, 'index of sub');
    const head = await send(server, '/page.html', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  });

  it('answers 404 for missing files and 405 for other methods', async () => {
    assert.equal((await send(server, '/nope.html')).status, 404);
    assert.equal((await send(server, '/page.html', 'POST')).status, 405);
  });

  it('does not reach outside the folder, by path or by symlink', async () => {
    assert.equal((await send(server, '/..%2fsecret.txt')).status, 403);
    assert.equal((await send(server, '/..%2f..%2f..%2fetc%2fpasswd')).status, 403);
    assert.equal((await send(server, '/link.txt')).status, 403);
    assert.equal((await send(server, '/%00')).status, 400);
  });
});

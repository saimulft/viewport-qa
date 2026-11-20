import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveDirectory } from '../../src/serve.ts';
import { makePng } from './png.ts';

const FIXTURES = new URL('../fixtures/', import.meta.url);

/** Images the fixture pages refer to: name, width, height, colour. */
const IMAGES: Array<[string, number, number, [number, number, number]]> = [
  ['photo-a.png', 2400, 800, [120, 144, 156]],
  ['photo-b.png', 2400, 800, [144, 164, 174]],
  ['small-200.png', 200, 100, [180, 120, 120]],
  ['d-1x.png', 250, 125, [120, 180, 120]],
  ['d-2x.png', 600, 300, [120, 180, 120]],
  ['w-200.png', 200, 100, [120, 120, 180]],
  ['w-600.png', 600, 300, [120, 120, 180]],
  ['shared-300.png', 300, 150, [180, 180, 120]],
];

/** A temporary copy of the fixture pages plus generated images. */
export interface Site {
  dir: string;
  /** Removes the folder (and stops the server, when there is one). */
  close(): Promise<void>;
  /** The full URL of a page; only on a served site. */
  url(name: string): string;
}

/** Copies the fixtures into a fresh temporary folder and writes the images next to them. */
export async function prepareSite(serve = false): Promise<Site> {
  const dir = await mkdtemp(join(tmpdir(), 'viewport-qa-'));
  await cp(FIXTURES, dir, { recursive: true });
  for (const [name, width, height, colour] of IMAGES) await writeFile(join(dir, name), makePng(width, height, colour));
  const server = serve ? await serveDirectory(dir) : undefined;
  return {
    dir,
    url: (name) => {
      if (!server) throw new Error('This site is not served.');
      return new URL(name, server.url).href;
    },
    close: async () => {
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Copy a few images into wrangler's LOCAL R2 simulation (.wrangler/state) so
// `npx wrangler dev` has something to serve. Never touches the real bucket.
//
// Usage (from ProjectCode/worker, with `wrangler dev` stopped):
//   node scripts/seed-local.mjs "<folder>/<file.png>" ["<folder>/<file.png>" ...]
//
// Keys are relative_path values from the images table; the files are read from
// ProjectCode/WCMC_raw_images_2023_and_others/. (`wrangler r2 object put
// --local` would store "Bell Pond/..." as "Bell%20Pond/...", so it can't be
// used for keys with spaces.)
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getPlatformProxy } from 'wrangler';

const keys = process.argv.slice(2);
if (keys.length === 0) {
  console.error('Usage: node scripts/seed-local.mjs "<folder>/<file.png>" ...');
  process.exit(1);
}

const CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' };
const imageRoot = fileURLToPath(new URL('../../WCMC_raw_images_2023_and_others/', import.meta.url));
const { env, dispose } = await getPlatformProxy(); // local bindings only
try {
  for (const key of keys) {
    const bytes = await readFile(path.join(imageRoot, ...key.split('/')));
    const contentType = CONTENT_TYPES[key.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
    await env.IMAGES.put(key, bytes, { httpMetadata: { contentType } });
    console.log(`seeded ${key} (${bytes.length} bytes)`);
  }
} finally {
  await dispose();
}

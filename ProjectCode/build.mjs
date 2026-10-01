// Build the public website: copy ONLY the dashboard's web files into dist/.
//
// Cloudflare Pages runs this on every deploy (root directory "ProjectCode",
// build command "node build.mjs", build output directory "dist"). Nothing else
// in the repository -- catalog_output/, deploy/, worker/, supabase/, the class
// files -- ever ends up on the site.
//
// Run it locally from ProjectCode/ to preview exactly what gets published:
//   node build.mjs
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_FILES = [
  'index.html',
  'admin.html',
  'privacy.html',
  'reset-password.html',
  'config.js',
  'auth.js',
  'dashboard.js',
  'admin.js',
  'reset.js',
  'dashboard.css',
];

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const file of WEB_FILES) {
  copyFileSync(join(here, file), join(out, file));  // throws if a file is missing
}
console.log(`Built ${out} with ${WEB_FILES.length} files: ${WEB_FILES.join(', ')}`);

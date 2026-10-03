// Build the public website: copy ONLY the dashboard's web files into dist/.
//
// Cloudflare Pages runs this on every deploy (root directory "ProjectCode",
// build command "node build.mjs", build output directory "dist"). Nothing else
// in the repository -- catalog_output/, deploy/, worker/, supabase/, the class
// files -- ever ends up on the site.
//
// Run it locally from ProjectCode/ to preview exactly what gets published:
//   node build.mjs
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_FILES = [
  // pages
  'index.html',
  'labeling.html',
  'admin.html',
  'privacy.html',
  'reset-password.html',
  '404.html',  // with this present, Pages answers unknown paths with a real 404
  // styles
  'base.css',
  'dashboard.css',
  'labeling.css',
  'viewer.css',
  // scripts
  'config.js',
  'theme.js',
  'demo.js',
  'auth.js',
  'ui.js',
  'labels.js',
  'fx.js',
  'viewer.js',
  'dashboard.js',
  'labeling.js',
  'admin.js',
  'reset.js',
  // images
  'icons.svg',
  'favicon.svg',
];

// Whole folders (the self-hosted fonts and their licence note)
const WEB_DIRS = ['fonts'];

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const file of WEB_FILES) {
  copyFileSync(join(here, file), join(out, file));  // throws if a file is missing
}
for (const dir of WEB_DIRS) {
  cpSync(join(here, dir), join(out, dir), { recursive: true });  // throws if the folder is missing
}
console.log(`Built ${out} with ${WEB_FILES.length} files and ${WEB_DIRS.length} folder(s): ${WEB_FILES.join(', ')}, ${WEB_DIRS.map(d => d + '/').join(', ')}`);

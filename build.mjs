// Builds both shipped artifacts, then asserts the three things that would fail
// SILENTLY at runtime if we got them wrong.
//
// Why esbuild and not Vite: the plugin frame is served into a sandbox WITHOUT
// allow-same-origin, so the document runs at an OPAQUE origin. `<script
// type="module">` is always fetched in CORS mode; from an opaque origin the
// Origin header is `null`, and TREK's plugin-frame controller sets
// Cross-Origin-Resource-Policy but never an Access-Control-Allow-Origin (the
// global cors() is `origin: false` in production). A stock ESM bundle therefore
// loads fine in `trek-plugin dev` and in /preview, and is blocked ONLY in a real
// production TREK. A classic IIFE <script src> is a no-cors fetch, which CORP
// already covers. Hence: format 'iife', and the assertions below.

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const shared = { bundle: true, legalComments: 'none', logLevel: 'warning' };

mkdirSync('server', { recursive: true });
mkdirSync('client', { recursive: true });

// The host injects `require('trek-plugin-sdk')` into the child process — a frozen
// shim exposing only definePlugin. It must stay external and unbundled.
await build({
  ...shared,
  entryPoints: ['src/server/index.ts'],
  outfile: 'server/index.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['trek-plugin-sdk'],
});

await build({
  ...shared,
  entryPoints: ['client-src/main.ts'],
  outfile: 'client/app.js',
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
});

await build({
  ...shared,
  entryPoints: ['client-src/app.css'],
  outfile: 'client/app.css',
});

// ---------------------------------------------------------------------------
// Guard rails. Each of these fails in a way that produces NO console output and
// NO server error — a blank white tab — so they have to be caught here.
// ---------------------------------------------------------------------------
const html = readFileSync('client/index.html', 'utf8');
const js = readFileSync('client/app.js', 'utf8');

// Without the marker, `pack`/`dev` inject nothing, window.trek is undefined, and
// the tab renders blank with an empty console.
assert.ok(html.includes('<!-- trek:ui -->'), 'client/index.html lost the <!-- trek:ui --> marker');

// A module script (or a `crossorigin` attribute) turns the bundle fetch into a
// CORS request that production TREK cannot answer. Dev and /preview will not
// reproduce it.
assert.ok(
  !/type\s*=\s*["']module["']/.test(html),
  'client/index.html uses <script type="module"> — blocked at the opaque origin in production',
);
assert.ok(!/\bcrossorigin\b/.test(html), 'client/index.html has a crossorigin attribute — same CORS trap');

// Belt and braces: prove the emitted bundle really is a classic script.
assert.ok(!/^\s*(?:import|export)\s/m.test(js), 'client/app.js is not a classic IIFE bundle');

// The plugin child process has no node_modules — the bundle must be fully
// self-contained. (`trek-plugin-sdk` is listed external as a guard, but we do
// not import it: definePlugin is an identity function and our own host-types.ts
// types the definition more precisely than the published SDK does.)
const serverJs = readFileSync('server/index.js', 'utf8');
const externalRequire = serverJs.match(/\brequire\(\s*["'][^"']+["']\s*\)/);
assert.ok(
  externalRequire === null,
  `server/index.js is not self-contained — it still calls ${externalRequire?.[0]}`,
);

// ---------------------------------------------------------------------------
// Staging directory for `trek-plugin dev-link`.
//
// TREK refuses to link a directory containing native binaries, and its scanner
// walks EVERYTHING — unlike `pack`, it has no node_modules skip list
// (server/src/nest/plugins/install/native-scan.ts:13). Our devDependencies pull
// in @rollup/rollup-win32-*.node via vitest, so linking the repo root always
// fails with "directory contains native binaries".
//
// So we mirror exactly the file set `pack` ships into a clean directory and link
// THAT. The plugin id comes from the manifest rather than the folder name
// (plugin-runtime.service.ts:787), so the directory may be called anything, and
// refreshing it on every build keeps the host's re-fork watcher pointed at
// current code.
// ---------------------------------------------------------------------------
const LINK_DIR = '.link';
const ROOT_FILES = ['trek-plugin.json', 'README.md', 'LICENSE', 'package.json'];

/**
 * Permissions only some TREK builds know about.
 *
 * These must NOT go in the shipped manifest: `install/manifest.ts:181` throws on
 * an unknown permission string, so declaring one would stop the plugin
 * installing at all on a host without the feature — a hard failure, not a
 * graceful degradation. The hook implementations ship unconditionally instead,
 * and are simply never invoked where the host has no mapping for them.
 *
 * These are added to the DEV-LINK copy only. `pack` reads the untouched root
 * manifest, so the published artifact stays installable everywhere.
 *
 * Detection is automatic: we ask the TREK checkout we are linked against whether
 * it knows the permission. Requiring a flag meant a plain `npm run build` would
 * silently revert the linked manifest and the feature would evaporate on the
 * next re-link. `--day-tint` / `--no-day-tint` force the answer either way.
 */
function hostKnowsPermission(permission) {
  const candidates = [
    process.env.TREK_REPO && path.join(process.env.TREK_REPO, 'server/src/nest/plugins/protocol/envelope.ts'),
    path.resolve('../../TREK/server/src/nest/plugins/protocol/envelope.ts'),
  ].filter(Boolean);

  for (const file of candidates) {
    if (existsSync(file)) return readFileSync(file, 'utf8').includes(`'${permission}'`);
  }
  return false;
}

const DAY_TINT = 'hook:day-tint-provider';
const dayTint = process.argv.includes('--no-day-tint')
  ? false
  : process.argv.includes('--day-tint') || process.env.TREK_DAY_TINT === '1' || hostKnowsPermission(DAY_TINT);

const OPTIONAL_PERMISSIONS = dayTint ? [DAY_TINT] : [];

// Overwrite in place rather than wiping first: once TREK has dev-linked this
// directory it holds a junction into it, and Windows answers EPERM to a
// recursive remove of a junction target that is in use. The shipped file set is
// fixed, so copying over the top is equivalent.
mkdirSync(LINK_DIR, { recursive: true });
for (const file of ROOT_FILES) {
  if (existsSync(file)) cpSync(file, `${LINK_DIR}/${file}`);
}

if (OPTIONAL_PERMISSIONS.length > 0) {
  const manifest = JSON.parse(readFileSync('trek-plugin.json', 'utf8'));
  const permissions = [...new Set([...manifest.permissions, ...OPTIONAL_PERMISSIONS])];
  writeFileSync(`${LINK_DIR}/trek-plugin.json`, `${JSON.stringify({ ...manifest, permissions }, null, 2)}\n`);
  console.log(`dev-link manifest: +${OPTIONAL_PERMISSIONS.join(', ')}`);
}
for (const dir of ['server', 'client']) {
  cpSync(dir, `${LINK_DIR}/${dir}`, { recursive: true });
}

/**
 * Expand `<!-- trek:ui -->` in the staged copy.
 *
 * `pack` and `trek-plugin dev` both inject the design kit at that marker, but the
 * HOST does not — plugin-frame.controller.ts just sendFile()s whatever is on
 * disk. So a dev-linked plugin serves the raw marker, `window.trek` is never
 * defined, and the tab dies with "could not reach TREK".
 *
 * client/index.html therefore keeps the marker (that is the shipping source, and
 * pack expands it at zip time), while the linked mirror gets it expanded here —
 * using the same SDK the CLI uses, so what we dev-link matches what we ship.
 */
async function loadKitInjector() {
  const local = [
    process.env.TREK_SDK_DIST,
    process.env.TREK_REPO && path.join(process.env.TREK_REPO, 'plugin-sdk/dist/index.js'),
    path.resolve('../../TREK/plugin-sdk/dist/index.js'),
  ].filter(Boolean);

  for (const candidate of local) {
    if (existsSync(candidate)) return (await import(pathToFileURL(candidate).href)).injectTrekUi;
  }
  return (await import('trek-plugin-sdk')).injectTrekUi;
}

const injectTrekUi = await loadKitInjector();
const linkedHtml = injectTrekUi(readFileSync('client/index.html', 'utf8'));
writeFileSync(`${LINK_DIR}/client/index.html`, linkedHtml);

assert.ok(!linkedHtml.includes('<!-- trek:ui -->'), `${LINK_DIR}/client/index.html still has an unexpanded marker`);
assert.ok(linkedHtml.includes('<script data-trek-ui>'), `${LINK_DIR}/client/index.html is missing the design kit`);

console.log('build ok — server/index.js, client/app.js, client/app.css');
console.log(`dev-link dir refreshed — ${process.cwd()}\\${LINK_DIR}`);

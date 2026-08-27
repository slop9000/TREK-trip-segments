// Resolves which `trek-plugin` CLI to run.
//
// The pinned devDependency is the authority. `pack` inlines the SDK's design kit
// into client/index.html at zip time, so validating with a different build than
// the one that packs is how an artifact ends up reproducible on exactly one
// machine. A local TREK checkout is opt-in, for testing against a host that is
// not released yet:
//
//   TREK_SDK_CLI=/abs/path/to/plugin-sdk/dist/cli/trek-plugin.js  npm run validate
//   TREK_REPO=/abs/path/to/TREK                                   npm run validate
//
// Falls back to `npx -y trek-plugin-sdk` when node_modules is not installed.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  process.env.TREK_SDK_CLI,
  process.env.TREK_REPO && path.join(process.env.TREK_REPO, 'plugin-sdk/dist/cli/trek-plugin.js'),
  path.resolve('node_modules/trek-plugin-sdk/dist/cli/trek-plugin.js'),
].filter(Boolean);

const cli = CANDIDATES.find((p) => existsSync(p));
const args = process.argv.slice(2);

const { status } = cli
  ? spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' })
  : spawnSync('npx', ['-y', 'trek-plugin-sdk', ...args], { stdio: 'inherit', shell: true });

process.exit(status ?? 1);

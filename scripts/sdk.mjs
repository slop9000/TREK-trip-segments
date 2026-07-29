// Resolves which `trek-plugin` CLI to run.
//
// The SDK published to npm as 1.5.0 predates three hook permissions that TREK
// 3.4.x itself accepts (`hook:day-schedule-provider`, `hook:map-layer-provider`,
// `hook:route-provider` — see server/src/nest/plugins/protocol/envelope.ts, the
// authority). Running the stale CLI's `validate` against our manifest produces
// false "unknown permission" errors. So: prefer a locally built checkout of the
// SDK that ships with TREK, and fall back to npm for anyone without one.
//
//   TREK_SDK_CLI=/abs/path/to/plugin-sdk/dist/cli/trek-plugin.js  npm run validate
//   TREK_REPO=/abs/path/to/TREK                                   npm run validate
//
// Falls back to `npx -y trek-plugin-sdk` when neither resolves.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  process.env.TREK_SDK_CLI,
  process.env.TREK_REPO && path.join(process.env.TREK_REPO, 'plugin-sdk/dist/cli/trek-plugin.js'),
  path.resolve('../../TREK/plugin-sdk/dist/cli/trek-plugin.js'),
].filter(Boolean);

const local = CANDIDATES.find((p) => existsSync(p));
const args = process.argv.slice(2);

const { status } = local
  ? spawnSync(process.execPath, [local, ...args], { stdio: 'inherit' })
  : spawnSync('npx', ['-y', 'trek-plugin-sdk', ...args], { stdio: 'inherit', shell: true });

if (!local) {
  console.warn(
    '\n[sdk] used the npm-published trek-plugin-sdk. If `validate` reports "unknown permission" for\n' +
      '      hook:day-schedule-provider or hook:map-layer-provider, that is the stale CLI, not the manifest —\n' +
      '      TREK 3.4.x accepts both. Point TREK_REPO at a TREK checkout with plugin-sdk built.\n',
  );
}

process.exit(status ?? 1);

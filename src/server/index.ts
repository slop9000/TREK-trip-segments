import { ensureSchema } from './schema';
import { routes } from './routes';
import { mcpTools } from './mcp-tools';
import { getSchedule } from './hooks/day-schedule';
import { getDayTints } from './hooks/day-tint';
import { getLayers } from './hooks/map-layer';
import { getSections } from './hooks/pdf-section';
import { getCards } from './hooks/trip-card';
import type { PluginDefinition } from '../shared/host-types';

/**
 * The plugin definition.
 *
 * The host loads this bundle with `require()` and takes `mod.default ?? mod`, so
 * a default export from an esbuild CJS bundle is a supported entry shape.
 *
 * Nothing is imported at runtime — not even `trek-plugin-sdk`. Its
 * `definePlugin` is an identity function used only for typing, and the shipped
 * examples (`plugin-sdk/examples/koffi`, `trip-doctor`) both export a plain
 * object. Keeping the bundle dependency-free means the child process needs no
 * module resolution at all, and our own `host-types.ts` types the definition
 * more precisely than the currently published SDK can.
 */
const plugin: PluginDefinition = {
  async onLoad(ctx) {
    // onLoad runs userless, so no trip read may happen here — creating our own
    // table is the one thing that is safe and worth doing eagerly.
    await ensureSchema(ctx);
    ctx.log.info('trip-segments loaded');
  },

  routes,
  /**
   * Inert. No released TREK reads `mcpTools`, 4.0.0 included. An unknown
   * definition key costs nothing, so the declarations stay ready rather than
   * being deleted now and rewritten later — see PluginMcpTool in
   * shared/host-types.ts for what is and is not known about the shape.
   */
  mcpTools,

  /**
   * Each of these needs its matching `hook:*` permission in trek-plugin.json.
   * Without it the plugin still installs and activates, and the hook is simply
   * never called — no error, no log, nothing. test/plugin.test.ts asserts the
   * two lists agree, with no exceptions: all five are granted as of 1.2.0.
   */
  hooks: {
    dayScheduleProvider: { getSchedule },
    dayTintProvider: { getDayTints },
    mapLayerProvider: { getLayers },
    pdfSectionProvider: { getSections },
    tripCardProvider: { getCards },
  },
};

export default plugin;

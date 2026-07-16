import type { OagenConfig } from '@workos/oagen';
import { workosEmittersPlugin } from './src/plugin.js';

// Minimal config for local emitter development.
// The canonical consumer config lives in openapi-spec/oagen.config.ts.
const config: OagenConfig = {
  ...workosEmittersPlugin,
};
export default config;

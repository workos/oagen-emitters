/**
 * Elixir extractor — delegates to the canonical implementation in @workos/oagen.
 *
 * Re-exported here so the emitter project can:
 *  1. Register it in oagen.config.ts alongside the emitter
 *  2. Customize hints if the generated SDK deviates from core defaults
 */
export { elixirExtractor } from '@workos/oagen/compat';

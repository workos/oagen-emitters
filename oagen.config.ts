import type { OagenConfig } from "@workos/oagen";
import { toCamelCase } from "@workos/oagen";
import { nodeEmitter } from "./src/node/index.js";
import { nodeExtractor } from "./src/compat/extractors/node.js";

/**
 * NestJS-style operationId transform. Strips "Controller" and extracts the
 * action after the first underscore: `FooController_bar` → `bar`.
 */
function nestjsOperationIdTransform(id: string): string {
  const stripped = id.replace(/Controller/g, "");
  const idx = stripped.indexOf("_");
  return idx !== -1 ? toCamelCase(stripped.slice(idx + 1)) : toCamelCase(stripped);
}

const config: OagenConfig = {
  emitters: [nodeEmitter],
  extractors: [nodeExtractor],
  smokeRunners: {
    node: "./smoke/sdk-node.ts",
  },
  operationIdTransform: nestjsOperationIdTransform,
};
export default config;

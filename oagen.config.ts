import type { OagenConfig } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { nodeEmitter } from './src/node/index.js';
import { pythonEmitter } from './src/python/index.js';
import { nodeExtractor } from './src/compat/extractors/node.js';
import { rubyExtractor } from './src/compat/extractors/ruby.js';
import { pythonExtractor } from './src/compat/extractors/python.js';
import { phpExtractor } from './src/compat/extractors/php.js';
import { goExtractor } from './src/compat/extractors/go.js';
import { rustExtractor } from './src/compat/extractors/rust.js';
import { kotlinExtractor } from './src/compat/extractors/kotlin.js';
import { dotnetExtractor } from './src/compat/extractors/dotnet.js';
import { elixirExtractor } from './src/compat/extractors/elixir.js';

/**
 * NestJS-style operationId transform. Strips "Controller" and extracts the
 * action after the first underscore: `FooController_bar` → `bar`.
 */
function nestjsOperationIdTransform(id: string): string {
  const stripped = id.replace(/Controller/g, '');
  const idx = stripped.indexOf('_');
  return idx !== -1 ? toCamelCase(stripped.slice(idx + 1)) : toCamelCase(stripped);
}

const config: OagenConfig = {
  emitters: [nodeEmitter, pythonEmitter],
  extractors: [
    nodeExtractor,
    rubyExtractor,
    pythonExtractor,
    phpExtractor,
    goExtractor,
    rustExtractor,
    kotlinExtractor,
    dotnetExtractor,
    elixirExtractor,
  ],
  smokeRunners: {
    node: './smoke/sdk-node.ts',
    ruby: './smoke/sdk-ruby.ts',
    python: './smoke/sdk-python.ts',
    php: './smoke/sdk-php.ts',
    go: './smoke/sdk-go.ts',
    rust: './smoke/sdk-rust.ts',
    elixir: './smoke/sdk-elixir.ts',
    kotlin: './smoke/sdk-kotlin.ts',
    dotnet: './smoke/sdk-dotnet.ts',
  },
  docUrl: 'https://workos.com/docs',
  operationIdTransform: nestjsOperationIdTransform,
};
export default config;

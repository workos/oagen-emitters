import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { OagenConfig } from '@workos/oagen';
import { nodeEmitter } from './node/index.js';
import { pythonEmitter } from './python/index.js';
import { phpEmitter } from './php/index.js';
import { goEmitter } from './go/index.js';
import { dotnetEmitter } from './dotnet/index.js';
import { kotlinEmitter } from './kotlin/index.js';
import { rubyEmitter } from './ruby/index.js';
import { rustEmitter } from './rust/index.js';
import { iosEmitter } from './ios/index.js';
import { androidEmitter } from './android/index.js';
import { elixirEmitter } from './elixir/index.js';
import { nodeExtractor } from './compat/extractors/node.js';
import { rubyExtractor } from './compat/extractors/ruby.js';
import { pythonExtractor } from './compat/extractors/python.js';
import { phpExtractor } from './compat/extractors/php.js';
import { goExtractor } from './compat/extractors/go.js';
import { rustExtractor } from './compat/extractors/rust.js';
import { kotlinExtractor } from './compat/extractors/kotlin.js';
import { dotnetExtractor } from './compat/extractors/dotnet.js';
import { elixirExtractor } from './compat/extractors/elixir.js';
import { iosExtractor } from './compat/extractors/ios.js';

// Resolve smoke runner paths relative to the package root so they work
// regardless of which project loads the config (CWD-independent).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const smokeDir = path.resolve(__dirname, '..', 'smoke');

export const workosEmittersPlugin: Pick<OagenConfig, 'emitters' | 'extractors' | 'smokeRunners'> = {
  emitters: [
    nodeEmitter,
    pythonEmitter,
    phpEmitter,
    goEmitter,
    dotnetEmitter,
    kotlinEmitter,
    rubyEmitter,
    rustEmitter,
    iosEmitter,
    androidEmitter,
    elixirEmitter,
  ],
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
    iosExtractor,
  ],
  smokeRunners: {
    node: path.join(smokeDir, 'sdk-node.ts'),
    ruby: path.join(smokeDir, 'sdk-ruby.ts'),
    python: path.join(smokeDir, 'sdk-python.ts'),
    php: path.join(smokeDir, 'sdk-php.ts'),
    go: path.join(smokeDir, 'sdk-go.ts'),
    rust: path.join(smokeDir, 'sdk-rust.ts'),
    elixir: path.join(smokeDir, 'sdk-elixir.ts'),
    kotlin: path.join(smokeDir, 'sdk-kotlin.ts'),
    dotnet: path.join(smokeDir, 'sdk-dotnet.ts'),
    ios: path.join(smokeDir, 'sdk-ios.ts'),
    android: path.join(smokeDir, 'sdk-android.ts'),
  },
};

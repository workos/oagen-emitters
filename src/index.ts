export { nodeEmitter } from './node/index.js';
export { pythonEmitter } from './python/index.js';
export { phpEmitter } from './php/index.js';
export { goEmitter } from './go/index.js';
export { dotnetEmitter } from './dotnet/index.js';
export { kotlinEmitter } from './kotlin/index.js';
export { rubyEmitter } from './ruby/index.js';
export { rustEmitter } from './rust/index.js';
export { iosEmitter } from './ios/index.js';
export { androidEmitter } from './android/index.js';
export { elixirEmitter } from './elixir/index.js';

export { nodeExtractor } from './compat/extractors/node.js';
export { rubyExtractor } from './compat/extractors/ruby.js';
export { pythonExtractor } from './compat/extractors/python.js';
export { phpExtractor } from './compat/extractors/php.js';
export { goExtractor } from './compat/extractors/go.js';
export { rustExtractor } from './compat/extractors/rust.js';
export { kotlinExtractor } from './compat/extractors/kotlin.js';
export { dotnetExtractor } from './compat/extractors/dotnet.js';
export { elixirExtractor } from './compat/extractors/elixir.js';
export { iosExtractor } from './compat/extractors/ios.js';

export { workosEmittersPlugin } from './plugin.js';

// Language-specific snippet emitters. The framework primitives
// (SnippetEmitter, runSnippetEmitters, snippetResultsToFiles,
// createExampleBuilder, collectSnippetArgs, collectWrapperArgs, etc.)
// live upstream in @workos/oagen — consumers import those from there.
export {
  rubySnippetEmitter,
  pythonSnippetEmitter,
  phpSnippetEmitter,
  goSnippetEmitter,
  dotnetSnippetEmitter,
  kotlinSnippetEmitter,
  rustSnippetEmitter,
  workosSnippetsPlugin,
} from './snippets/index.js';

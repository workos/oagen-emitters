import type { SnippetEmitter } from '@workos/oagen';
import { dotnetSnippetEmitter } from './dotnet.js';
import { goSnippetEmitter } from './go.js';
import { kotlinSnippetEmitter } from './kotlin.js';
import { phpSnippetEmitter } from './php.js';
import { pythonSnippetEmitter } from './python.js';
import { rubySnippetEmitter } from './ruby.js';
import { rustSnippetEmitter } from './rust.js';

/**
 * Bundle of snippet emitters for every WorkOS SDK language we currently
 * generate call-site samples for. Node is intentionally absent — the docs
 * pipeline still owns hand-authored TypeScript samples there.
 *
 * ```ts
 * import { runSnippetEmitters, workosSnippetsPlugin } from '@workos/oagen-emitters';
 *
 * const snippets = runSnippetEmitters(workosSnippetsPlugin.snippets, ctx);
 * ```
 *
 * Each entry mirrors a published WorkOS SDK and reuses that emitter's naming
 * helpers (`src/<lang>/naming.ts`), so generated samples stay in lockstep
 * with the SDK they document — method names, mount-target casing, parameter
 * names, and reserved-word handling all match what the real SDK exposes.
 */
export const workosSnippetsPlugin: { snippets: SnippetEmitter[] } = {
  snippets: [
    rubySnippetEmitter,
    pythonSnippetEmitter,
    phpSnippetEmitter,
    goSnippetEmitter,
    dotnetSnippetEmitter,
    kotlinSnippetEmitter,
    rustSnippetEmitter,
  ],
};

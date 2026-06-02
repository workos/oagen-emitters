import { rubySnippetEmitter } from './ruby.js';
import type { SnippetEmitter } from './types.js';

/**
 * Bundle of snippet emitters for every WorkOS SDK language. Intended for
 * consumers (the docs build, partner tooling) that want a one-line opt-in:
 *
 * ```ts
 * import { runSnippetEmitters, workosSnippetsPlugin } from '@workos/oagen-emitters';
 *
 * const snippets = runSnippetEmitters(workosSnippetsPlugin.snippets, ctx);
 * ```
 *
 * Each entry mirrors a published WorkOS SDK and reuses that emitter's naming
 * helpers, so generated samples stay in lockstep with the SDK they document.
 */
export const workosSnippetsPlugin: { snippets: SnippetEmitter[] } = {
  snippets: [rubySnippetEmitter],
};

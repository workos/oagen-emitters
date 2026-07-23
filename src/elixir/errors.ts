import type { EmitterContext, GeneratedFile } from '@workos/oagen';
import { toSnakeCase } from '@workos/oagen';
import { nsPascal } from './naming.js';

/** snake_case atom (with leading colon) for a policy error-kind name. */
export function errorKindAtom(kindName: string): string {
  return `:${toSnakeCase(kindName)}`;
}

/** All distinct error-kind atoms from the spec's error policy, in stable order. */
export function errorKindAtoms(ctx: EmitterContext): string[] {
  const policy = ctx.spec.sdk.errors;
  const atoms: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const atom = errorKindAtom(name);
    if (!seen.has(atom)) {
      seen.add(atom);
      atoms.push(atom);
    }
  };
  for (const status of Object.keys(policy.statusCodeMap)
    .map(Number)
    .sort((a, b) => a - b)) {
    push(policy.statusCodeMap[status]);
  }
  push(policy.serverErrorKind);
  push(policy.clientErrorKind);
  return atoms;
}

/**
 * Generate the error modules: a shared `Error` union type plus `ApiError`,
 * `TransportError`, and `ConfigurationError` exception structs. SDK functions
 * return tagged tuples — errors are `defexception`s only so callers *may*
 * raise them.
 */
export function generateErrors(ctx: EmitterContext): GeneratedFile[] {
  const ns = nsPascal(ctx);
  const kinds = errorKindAtoms(ctx);
  const lines: string[] = [];

  lines.push(`defmodule ${ns}.Error do`);
  lines.push('  @moduledoc """');
  lines.push('  Union of the error values SDK functions can return in `{:error, error}` tuples.');
  lines.push('  """');
  lines.push('');
  lines.push(`  @type error :: ${ns}.ApiError.t() | ${ns}.TransportError.t()`);
  lines.push('end');
  lines.push('');

  lines.push(`defmodule ${ns}.ApiError do`);
  lines.push('  @moduledoc """');
  lines.push('  A non-2xx response from the API.');
  lines.push('');
  lines.push('  The `:kind` field classifies the failure by status code (e.g. `:not_found`),');
  lines.push('  so callers can pattern-match without memorizing status numbers.');
  lines.push('  """');
  lines.push('');
  lines.push('  defexception [:message, :status, :kind, :request_id, :code, :body]');
  lines.push('');
  lines.push('  @type kind ::');
  for (let i = 0; i < kinds.length; i++) {
    const sep = i === 0 ? '          ' : '          | ';
    lines.push(`${sep}${kinds[i]}`);
  }
  lines.push('');
  lines.push('  @type t :: %__MODULE__{');
  lines.push('          message: String.t(),');
  lines.push('          status: pos_integer(),');
  lines.push('          kind: kind(),');
  lines.push('          request_id: String.t() | nil,');
  lines.push('          code: String.t() | nil,');
  lines.push('          body: map() | String.t() | nil');
  lines.push('        }');
  lines.push('end');
  lines.push('');

  lines.push(`defmodule ${ns}.TransportError do`);
  lines.push('  @moduledoc """');
  lines.push('  A network-level failure (DNS, timeout, connection refused).');
  lines.push('  """');
  lines.push('');
  lines.push('  defexception [:message, :reason]');
  lines.push('');
  lines.push('  @type t :: %__MODULE__{message: String.t(), reason: term()}');
  lines.push('end');
  lines.push('');

  lines.push(`defmodule ${ns}.ConfigurationError do`);
  lines.push('  @moduledoc """');
  lines.push('  Missing or invalid client configuration (e.g. no API key). Raised from');
  lines.push(`  \`${ns}.Client.new/1\` — configuration problems are programmer errors, not`);
  lines.push('  runtime failures.');
  lines.push('  """');
  lines.push('');
  lines.push('  defexception [:message]');
  lines.push('');
  lines.push('  @type t :: %__MODULE__{message: String.t()}');
  lines.push('end');

  return [
    {
      path: `lib/${ctx.namespace}/errors.ex`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}

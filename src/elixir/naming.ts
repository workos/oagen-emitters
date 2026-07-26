import type { EmitterContext } from '@workos/oagen';
import { toPascalCase, toSnakeCase } from '@workos/oagen';
import { applyAcronymFixes, stripUrnPrefix } from '../shared/naming-utils.js';

/**
 * Core generated module short-names that a model/enum must not shadow.
 * A model named `Client` would collide with the generated HTTP client module,
 * so it gets a `Model` suffix (consistently applied at every reference site).
 */
const RESERVED_MODULE_NAMES = new Set([
  'Client',
  'Cast',
  'Page',
  'Error',
  'ApiError',
  'TransportError',
  'ConfigurationError',
  'TestFixtures',
  'MixProject',
]);

/** Elixir reserved words that cannot be used as bare function/variable names. */
const ELIXIR_RESERVED_WORDS = new Set([
  'do',
  'end',
  'fn',
  'def',
  'defp',
  'defmodule',
  'defstruct',
  'if',
  'unless',
  'case',
  'cond',
  'when',
  'and',
  'or',
  'not',
  'in',
  'true',
  'false',
  'nil',
  'after',
  'else',
  'catch',
  'rescue',
  'require',
  'import',
  'alias',
  'use',
  'quote',
  'unquote',
  'receive',
  'try',
  'raise',
  'throw',
  'super',
]);

/** Collapse a snake_case string into a valid Elixir identifier. */
function sanitizeSnake(snake: string): string {
  let s = snake.replace(/[^a-zA-Z0-9_]/g, '_');
  if (/^[0-9]/.test(s)) s = `n_${s}`;
  if (s === '') s = 'value';
  return s;
}

/** PascalCase module short name for a model/enum/service, acronym-fixed and collision-guarded. */
export function moduleName(name: string): string {
  const pascal = applyAcronymFixes(toPascalCase(stripUrnPrefix(name)));
  return RESERVED_MODULE_NAMES.has(pascal) ? `${pascal}Model` : pascal;
}

/**
 * The SDK's root module name. Consumers conventionally pass a lowercase
 * `--namespace` (e.g. `workos`), so Pascalize when the given namespacePascal
 * carries no casing, and apply the shared acronym fixes either way
 * (`workos` → `WorkOS`, `acme` → `Acme`). File paths keep `ctx.namespace`.
 */
export function nsPascal(ctx: EmitterContext): string {
  const raw = ctx.namespacePascal;
  const cased = /[A-Z]/.test(raw) ? raw : toPascalCase(raw);
  return applyAcronymFixes(cased);
}

/** Fully-qualified module name under the SDK namespace (e.g. `WorkOS.Organization`). */
export function fullModuleName(ctx: EmitterContext, name: string): string {
  return `${nsPascal(ctx)}.${moduleName(name)}`;
}

/** snake_case file basename for a model/enum/service module. */
export function fileName(name: string): string {
  return sanitizeSnake(toSnakeCase(moduleName(name)));
}

/**
 * snake_case function name with reserved-word guard. Resolved operation names
 * arrive already snake_case and pass through unchanged — re-splitting via
 * toSnakeCase would corrupt digit-bearing reviewed names ("complete_oauth2"
 * must not become "complete_oauth_2").
 */
export function functionName(name: string): string {
  const snake = sanitizeSnake(/^[a-z][a-z0-9_]*$/.test(name) ? name : toSnakeCase(name));
  return ELIXIR_RESERVED_WORDS.has(snake) ? `${snake}_` : snake;
}

/** snake_case variable/parameter name with reserved-word guard. */
export function varName(name: string): string {
  return functionName(name);
}

/** Struct field atom name (without the leading colon). */
export function fieldName(name: string): string {
  const snake = sanitizeSnake(toSnakeCase(name));
  return ELIXIR_RESERVED_WORDS.has(snake) ? `${snake}_` : snake;
}

/** snake_case accessor recorded as the manifest `service` field. */
export function servicePropertyName(mountOn: string): string {
  return toSnakeCase(mountOn);
}

/** Render a string as an Elixir atom literal, quoting when necessary. */
export function atomLiteral(value: string): string {
  if (/^[a-z_][a-zA-Z0-9_]*[?!]?$/.test(value)) return `:${value}`;
  return `:"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Escape arbitrary text for embedding in an Elixir double-quoted string. */
export function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/#\{/g, '\\#{').replace(/\n/g, '\\n');
}

/**
 * Escape description text for embedding in a `@moduledoc`/`@doc` heredoc.
 * Heredoc terminators and interpolation markers must not survive verbatim —
 * a description containing `"""` or `#{` would otherwise break the module.
 */
export function escapeDoc(value: string): string {
  return value.replace(/"""/g, '\\"\\"\\"').replace(/#\{/g, '\\#{');
}

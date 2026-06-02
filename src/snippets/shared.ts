import type { EmitterContext, Field, Model, Parameter, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import type { ExampleBuilder } from './example-builder.js';

/**
 * One argument resolved for a call-site snippet. The {@link wireName} stays in
 * the spec's casing so each language emitter can apply its own field/param
 * casing rules (snake_case for Python/Ruby/PHP, PascalCase for Go/.NET, etc.).
 *
 * Path and query params carry their {@link Parameter} so emitters can pick
 * language-specific safe names; body args carry their {@link Field} so
 * emitters can read field-level metadata (deprecated, type details).
 */
export interface SnippetArg {
  /** 'path' | 'body' | 'query' — used by emitters to pick a casing rule. */
  source: 'path' | 'body' | 'query';
  /** Spec wire name (e.g. `domain_data`, `client_id`). */
  wireName: string;
  /** Pre-computed illustrative value (string, number, array, object, ...). */
  value: unknown;
  /** Original parameter for path/query args, null for body fields. */
  parameter: Parameter | null;
  /** Original field for body args, null for path/query params. */
  field: Field | null;
}

/**
 * Resolve the set of required arguments for a snippet. Body fields are
 * expanded from the request body model; defaults / inferFromClient fields
 * are filtered out (they're injected by the SDK, not the caller).
 *
 * Iteration order: path params, then required body fields, then required
 * query params. Wire-name collisions between body and path are reported in
 * {@link collisionNames} so the emitter can rename whichever side it
 * prefers (e.g. prefix body field with `body_`).
 */
export interface CollectedArgs {
  args: SnippetArg[];
  /** Body field wire names that also appear as path params. */
  collisionNames: Set<string>;
}

export function collectSnippetArgs(
  resolved: ResolvedOperation,
  ctx: EmitterContext,
  examples: ExampleBuilder,
): CollectedArgs {
  const op = resolved.operation;
  const hidden = hiddenParamSet(resolved);
  const args: SnippetArg[] = [];
  const pathWireNames = new Set<string>();

  for (const p of op.pathParams) {
    if (!p.required) continue;
    if (hidden.has(p.name)) continue;
    pathWireNames.add(p.name);
    args.push({
      source: 'path',
      wireName: p.name,
      value: exampleForParam(p, examples),
      parameter: p,
      field: null,
    });
  }

  const collisionNames = new Set<string>();
  if (op.requestBody?.kind === 'model') {
    const bodyModel = findModel(ctx, op.requestBody.name);
    if (bodyModel) {
      for (const f of bodyModel.fields) {
        if (!f.required || f.deprecated) continue;
        if (hidden.has(f.name)) continue;
        if (pathWireNames.has(f.name)) collisionNames.add(f.name);
        args.push({
          source: 'body',
          wireName: f.name,
          value: exampleForField(f, examples),
          parameter: null,
          field: f,
        });
      }
    }
  }

  for (const q of op.queryParams) {
    if (!q.required) continue;
    if (hidden.has(q.name)) continue;
    args.push({
      source: 'query',
      wireName: q.name,
      value: exampleForParam(q, examples),
      parameter: q,
      field: null,
    });
  }

  return { args, collisionNames };
}

/** Build the arg list for a single split (wrapper) variant. */
export function collectWrapperArgs(
  wrapper: ResolvedWrapper,
  ctx: EmitterContext,
  examples: ExampleBuilder,
): SnippetArg[] {
  const args: SnippetArg[] = [];
  for (const p of resolveWrapperParams(wrapper, ctx)) {
    if (p.isOptional) continue;
    args.push({
      source: 'body',
      wireName: p.paramName,
      value: p.field ? exampleForField(p.field, examples) : 'string_example',
      parameter: null,
      field: p.field,
    });
  }
  return args;
}

export function hiddenParamSet(resolved: ResolvedOperation): Set<string> {
  const hidden = new Set<string>();
  for (const k of Object.keys(resolved.defaults)) hidden.add(k);
  for (const k of resolved.inferFromClient) hidden.add(k);
  return hidden;
}

function findModel(ctx: EmitterContext, name: string): Model | undefined {
  return ctx.spec.models.find((m) => m.name === name);
}

function exampleForParam(p: Parameter, examples: ExampleBuilder): unknown {
  if (p.example !== undefined) return p.example;
  if (p.default !== undefined) return p.default;
  return examples.forType(p.type);
}

function exampleForField(f: Field, examples: ExampleBuilder): unknown {
  return examples.forField(f);
}

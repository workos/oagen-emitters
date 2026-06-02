import type { EmitterContext, Field, Model, Parameter, ResolvedOperation, ResolvedWrapper } from '@workos/oagen';
import { toSnakeCase } from '@workos/oagen';
import { buildExportedClassNameSet, fieldName, resolveServiceTarget, safeParamName } from '../ruby/naming.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import type { ExampleBuilder } from './example-builder.js';
import type { SnippetEmitter } from './types.js';

const INDENT = '  ';

export const rubySnippetEmitter: SnippetEmitter = {
  language: 'ruby',
  fileExtension: 'rb',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder) return null;

    const exportedClasses = buildExportedClassNameSet(ctx);
    const accessor = serviceAccessor(resolved.mountOn, exportedClasses);

    // Split (polymorphic) operations expose one method per wrapper. Emit a
    // snippet for the first wrapper; callers wanting all variants iterate
    // resolved.wrappers themselves.
    if (resolved.wrappers && resolved.wrappers.length > 0) {
      const first = resolved.wrappers[0]!;
      return renderWrapperCall(first, accessor, ctx, examples);
    }

    const args = collectArgs(resolved, ctx, examples);
    return renderCall(accessor, resolved.methodName, args);
  },
};

interface RubyArg {
  keyword: string;
  value: string;
}

function collectArgs(resolved: ResolvedOperation, ctx: EmitterContext, examples: ExampleBuilder): RubyArg[] {
  const op = resolved.operation;
  const args: RubyArg[] = [];
  const seen = new Set<string>();
  const hidden = hiddenParamSet(resolved);

  for (const p of op.pathParams) {
    if (!p.required) continue;
    const name = safeParamName(p.name);
    if (seen.has(name)) continue;
    seen.add(name);
    args.push({ keyword: name, value: renderValue(exampleForParam(p, examples)) });
  }

  const pathNames = new Set(args.map((a) => a.keyword));
  if (op.requestBody?.kind === 'model') {
    const bodyModel = findModel(ctx, op.requestBody.name);
    if (bodyModel) {
      for (const f of bodyModel.fields) {
        if (!f.required || f.deprecated) continue;
        if (hidden.has(f.name)) continue;
        const base = fieldName(f.name);
        const name = pathNames.has(base) ? `body_${base}` : base;
        if (seen.has(name)) continue;
        seen.add(name);
        args.push({ keyword: name, value: renderValue(exampleForField(f, examples)) });
      }
    }
  }

  for (const q of op.queryParams) {
    if (!q.required) continue;
    if (hidden.has(q.name)) continue;
    const name = safeParamName(q.name);
    if (seen.has(name)) continue;
    seen.add(name);
    args.push({ keyword: name, value: renderValue(exampleForParam(q, examples)) });
  }

  return args;
}

function renderWrapperCall(
  wrapper: ResolvedWrapper,
  accessor: string,
  ctx: EmitterContext,
  examples: ExampleBuilder,
): string {
  const params = resolveWrapperParams(wrapper, ctx);
  const args: RubyArg[] = [];
  for (const p of params) {
    if (p.isOptional) continue;
    const name = safeParamName(p.paramName);
    const value = p.field ? renderValue(exampleForField(p.field, examples)) : renderValue('string_example');
    args.push({ keyword: name, value });
  }
  return renderCall(accessor, wrapper.name, args);
}

function renderCall(accessor: string, method: string, args: RubyArg[]): string {
  const lines: string[] = [];
  lines.push('require "workos"');
  lines.push('');
  lines.push('WorkOS.configure do |config|');
  lines.push(`${INDENT}config.api_key = "sk_example_123456789"`);
  lines.push('end');
  lines.push('');

  const target = `WorkOS.client.${accessor}.${method}`;
  if (args.length === 0) {
    lines.push(target);
    return lines.join('\n');
  }

  if (args.length === 1 && !args[0]!.value.includes('\n')) {
    const a = args[0]!;
    lines.push(`${target}(${a.keyword}: ${a.value})`);
    return lines.join('\n');
  }

  lines.push(`${target}(`);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const trailing = i < args.length - 1 ? ',' : '';
    const valueIndented = indentContinuationLines(a.value, INDENT);
    lines.push(`${INDENT}${a.keyword}: ${valueIndented}${trailing}`);
  }
  lines.push(')');

  return lines.join('\n');
}

function serviceAccessor(mountOn: string, exportedClasses: Set<string>): string {
  // The accessor uses the raw mount target (no `Service` suffix) to match
  // the `client.organization_membership` style documented in workos-ruby.
  void resolveServiceTarget(mountOn, exportedClasses);
  return toSnakeCase(mountOn);
}

function hiddenParamSet(resolved: ResolvedOperation): Set<string> {
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

// ---------------------------------------------------------------------------
// Ruby literal rendering
// ---------------------------------------------------------------------------

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return rubyString(value);
  if (Array.isArray(value)) return renderArray(value);
  if (typeof value === 'object') return renderHash(value as Record<string, unknown>);
  return 'nil';
}

function rubyString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderArray(items: unknown[]): string {
  if (items.length === 0) return '[]';
  const rendered = items.map((v) => renderValue(v));
  const oneline = `[${rendered.join(', ')}]`;
  if (oneline.length <= 80 && rendered.every((r) => !r.includes('\n'))) return oneline;
  const lines: string[] = ['['];
  for (let i = 0; i < rendered.length; i++) {
    const trailing = i < rendered.length - 1 ? ',' : '';
    lines.push(`${INDENT}${indentContinuationLines(rendered[i]!, INDENT)}${trailing}`);
  }
  lines.push(']');
  return lines.join('\n');
}

function renderHash(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return '{}';
  const rendered = entries.map(([k, v]) => ({ key: k, value: renderValue(v) }));
  const oneLineParts = rendered.map((e) => `${formatInlineKey(e.key)} ${e.value}`);
  const oneline = `{ ${oneLineParts.join(', ')} }`;
  if (oneline.length <= 80 && rendered.every((e) => !e.value.includes('\n'))) return oneline;

  const lines: string[] = ['{'];
  for (let i = 0; i < rendered.length; i++) {
    const e = rendered[i]!;
    const trailing = i < rendered.length - 1 ? ',' : '';
    lines.push(`${INDENT}${formatInlineKey(e.key)} ${indentContinuationLines(e.value, INDENT)}${trailing}`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** Format a hash key including its trailing separator (`name:` or `"weird-name" =>`). */
function formatInlineKey(name: string): string {
  if (/^[a-z_][a-zA-Z0-9_]*$/.test(name)) return `${name}:`;
  return `"${name.replace(/"/g, '\\"')}" =>`;
}

/**
 * Indent every line of `s` after the first by `indent`. The first line is
 * returned unchanged because the caller usually prepends its own prefix
 * (e.g. `"  name: "`).
 */
function indentContinuationLines(s: string, indent: string): string {
  if (!s.includes('\n')) return s;
  const lines = s.split('\n');
  return lines.map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n');
}

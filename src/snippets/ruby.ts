import type { EmitterContext, SnippetArg, SnippetEmitter } from '@workos/oagen';
import { collectSnippetArgs, collectWrapperArgs, toSnakeCase } from '@workos/oagen';
import { buildExportedClassNameSet, fieldName, resolveServiceTarget, safeParamName } from '../ruby/naming.js';

const INDENT = '  ';

export const rubySnippetEmitter: SnippetEmitter = {
  language: 'ruby',
  fileExtension: 'rb',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder) return null;

    const accessor = serviceAccessor(resolved.mountOn, ctx);

    if (resolved.wrappers && resolved.wrappers.length > 0) {
      const wrapper = resolved.wrappers[0]!;
      const args = collectWrapperArgs(wrapper, ctx, examples);
      return renderCall(accessor, wrapper.name, toRubyArgs(args, new Set()));
    }

    const { args, collisionNames } = collectSnippetArgs(resolved, ctx, examples);
    return renderCall(accessor, resolved.methodName, toRubyArgs(args, collisionNames));
  },
};

interface RubyArg {
  keyword: string;
  value: string;
}

function toRubyArgs(args: SnippetArg[], collisionNames: Set<string>): RubyArg[] {
  const seen = new Set<string>();
  const out: RubyArg[] = [];
  for (const a of args) {
    const keyword = rubyKeyword(a, collisionNames);
    if (seen.has(keyword)) continue;
    seen.add(keyword);
    out.push({ keyword, value: renderValue(a.value) });
  }
  return out;
}

function rubyKeyword(arg: SnippetArg, collisions: Set<string>): string {
  if (arg.source === 'body') {
    const base = fieldName(arg.wireName);
    return collisions.has(arg.wireName) ? `body_${base}` : base;
  }
  // path / query
  return safeParamName(arg.wireName);
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

function serviceAccessor(mountOn: string, ctx: EmitterContext): string {
  // The accessor uses the raw mount target (no `Service` suffix) to match
  // the `client.organization_membership` style documented in workos-ruby.
  void resolveServiceTarget(mountOn, buildExportedClassNameSet(ctx));
  return toSnakeCase(mountOn);
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

function formatInlineKey(name: string): string {
  if (/^[a-z_][a-zA-Z0-9_]*$/.test(name)) return `${name}:`;
  return `"${name.replace(/"/g, '\\"')}" =>`;
}

function indentContinuationLines(s: string, indent: string): string {
  if (!s.includes('\n')) return s;
  const lines = s.split('\n');
  return lines.map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n');
}

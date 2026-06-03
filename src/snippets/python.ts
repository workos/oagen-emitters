import type { SnippetArg, SnippetEmitter } from '@workos/oagen';
import { collectSnippetArgs, collectWrapperArgs, toSnakeCase } from '@workos/oagen';
import { fieldName, safeParamName } from '../python/naming.js';

const INDENT = '    ';

export const pythonSnippetEmitter: SnippetEmitter = {
  language: 'python',
  fileExtension: 'py',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder) return null;

    const accessor = toSnakeCase(resolved.mountOn);

    if (resolved.wrappers && resolved.wrappers.length > 0) {
      const wrapper = resolved.wrappers[0]!;
      const args = collectWrapperArgs(wrapper, ctx, examples);
      return renderCall(accessor, wrapper.name, toPyArgs(args, new Set()));
    }

    const { args, collisionNames } = collectSnippetArgs(resolved, ctx, examples);
    return renderCall(accessor, resolved.methodName, toPyArgs(args, collisionNames));
  },
};

interface PyArg {
  keyword: string;
  value: string;
}

function toPyArgs(args: SnippetArg[], collisionNames: Set<string>): PyArg[] {
  const seen = new Set<string>();
  const out: PyArg[] = [];
  for (const a of args) {
    const keyword = pythonKeyword(a, collisionNames);
    if (seen.has(keyword)) continue;
    seen.add(keyword);
    out.push({ keyword, value: renderValue(a.value) });
  }
  return out;
}

function pythonKeyword(arg: SnippetArg, collisions: Set<string>): string {
  if (arg.source === 'body') {
    const base = fieldName(arg.wireName);
    return collisions.has(arg.wireName) ? `body_${base}` : base;
  }
  return safeParamName(arg.wireName);
}

function renderCall(accessor: string, method: string, args: PyArg[]): string {
  const lines: string[] = [];
  lines.push('from workos import WorkOSClient');
  lines.push('');
  lines.push('client = WorkOSClient(api_key="sk_example_123456789", client_id="client_123456789")');
  lines.push('');

  const target = `client.${accessor}.${method}`;
  if (args.length === 0) {
    lines.push(`${target}()`);
    return lines.join('\n');
  }

  if (args.length === 1 && !args[0]!.value.includes('\n')) {
    const a = args[0]!;
    lines.push(`${target}(${a.keyword}=${a.value})`);
    return lines.join('\n');
  }

  lines.push(`${target}(`);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const trailing = i < args.length - 1 ? ',' : '';
    const valueIndented = indentContinuationLines(a.value, INDENT);
    lines.push(`${INDENT}${a.keyword}=${valueIndented}${trailing}`);
  }
  lines.push(')');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Python literal rendering
// ---------------------------------------------------------------------------

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return pythonString(value);
  if (Array.isArray(value)) return renderArray(value);
  if (typeof value === 'object') return renderDict(value as Record<string, unknown>);
  return 'None';
}

function pythonString(s: string): string {
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

function renderDict(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return '{}';
  const rendered = entries.map(([k, v]) => ({ key: k, value: renderValue(v) }));
  const oneline = `{${rendered.map((e) => `"${e.key}": ${e.value}`).join(', ')}}`;
  if (oneline.length <= 80 && rendered.every((e) => !e.value.includes('\n'))) return oneline;

  const lines: string[] = ['{'];
  for (let i = 0; i < rendered.length; i++) {
    const e = rendered[i]!;
    const trailing = i < rendered.length - 1 ? ',' : '';
    lines.push(`${INDENT}"${e.key}": ${indentContinuationLines(e.value, INDENT)}${trailing}`);
  }
  lines.push('}');
  return lines.join('\n');
}

function indentContinuationLines(s: string, indent: string): string {
  if (!s.includes('\n')) return s;
  const lines = s.split('\n');
  return lines.map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n');
}

import type { SnippetArg, SnippetEmitter } from '@workos/oagen';
import { collectSnippetArgs, collectWrapperArgs } from '@workos/oagen';
import { fieldName, servicePropertyName } from '../php/naming.js';

const INDENT = '    ';

export const phpSnippetEmitter: SnippetEmitter = {
  language: 'php',
  fileExtension: 'php',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder) return null;

    const accessor = servicePropertyName(resolved.mountOn);
    const method = fieldName(
      resolved.wrappers && resolved.wrappers.length > 0 ? resolved.wrappers[0]!.name : resolved.methodName,
    );

    let args: SnippetArg[];
    let collisionNames: Set<string>;
    if (resolved.wrappers && resolved.wrappers.length > 0) {
      args = collectWrapperArgs(resolved.wrappers[0]!, ctx, examples);
      collisionNames = new Set();
    } else {
      const collected = collectSnippetArgs(resolved, ctx, examples);
      args = collected.args;
      collisionNames = collected.collisionNames;
    }

    return renderCall(accessor, method, toPhpArgs(args, collisionNames));
  },
};

interface PhpArg {
  keyword: string;
  value: string;
}

function toPhpArgs(args: SnippetArg[], collisions: Set<string>): PhpArg[] {
  const seen = new Set<string>();
  const out: PhpArg[] = [];
  for (const a of args) {
    const keyword = phpKeyword(a, collisions);
    if (seen.has(keyword)) continue;
    seen.add(keyword);
    out.push({ keyword, value: renderValue(a.value) });
  }
  return out;
}

function phpKeyword(arg: SnippetArg, collisions: Set<string>): string {
  const base = fieldName(arg.wireName);
  if (arg.source === 'body' && collisions.has(arg.wireName)) return `body${capitalize(base)}`;
  return base;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function renderCall(accessor: string, method: string, args: PhpArg[]): string {
  const lines: string[] = [];
  lines.push('<?php');
  lines.push('');
  lines.push('use WorkOS\\WorkOS;');
  lines.push('');
  lines.push('$workos = new WorkOS(');
  lines.push(`${INDENT}apiKey: 'sk_example_123456789',`);
  lines.push(`${INDENT}clientId: 'client_123456789',`);
  lines.push(');');
  lines.push('');

  const target = `$workos->${accessor}()->${method}`;
  if (args.length === 0) {
    lines.push(`${target}();`);
    return lines.join('\n');
  }

  if (args.length === 1 && !args[0]!.value.includes('\n')) {
    const a = args[0]!;
    lines.push(`${target}(${a.keyword}: ${a.value});`);
    return lines.join('\n');
  }

  lines.push(`${target}(`);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const trailing = i < args.length - 1 ? ',' : ',';
    const valueIndented = indentContinuationLines(a.value, INDENT);
    lines.push(`${INDENT}${a.keyword}: ${valueIndented}${trailing}`);
  }
  lines.push(');');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// PHP literal rendering
// ---------------------------------------------------------------------------

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return phpString(value);
  if (Array.isArray(value)) return renderArray(value);
  if (typeof value === 'object') return renderAssoc(value as Record<string, unknown>);
  return 'null';
}

function phpString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function renderArray(items: unknown[]): string {
  if (items.length === 0) return '[]';
  const rendered = items.map((v) => renderValue(v));
  const oneline = `[${rendered.join(', ')}]`;
  if (oneline.length <= 80 && rendered.every((r) => !r.includes('\n'))) return oneline;
  const lines: string[] = ['['];
  for (let i = 0; i < rendered.length; i++) {
    const trailing = i < rendered.length - 1 ? ',' : ',';
    lines.push(`${INDENT}${indentContinuationLines(rendered[i]!, INDENT)}${trailing}`);
  }
  lines.push(']');
  return lines.join('\n');
}

function renderAssoc(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return '[]';
  const rendered = entries.map(([k, v]) => ({ key: k, value: renderValue(v) }));
  const oneline = `[${rendered.map((e) => `'${e.key}' => ${e.value}`).join(', ')}]`;
  if (oneline.length <= 80 && rendered.every((e) => !e.value.includes('\n'))) return oneline;
  const lines: string[] = ['['];
  for (let i = 0; i < rendered.length; i++) {
    const e = rendered[i]!;
    const trailing = i < rendered.length - 1 ? ',' : ',';
    lines.push(`${INDENT}'${e.key}' => ${indentContinuationLines(e.value, INDENT)}${trailing}`);
  }
  lines.push(']');
  return lines.join('\n');
}

function indentContinuationLines(s: string, indent: string): string {
  if (!s.includes('\n')) return s;
  const lines = s.split('\n');
  return lines.map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n');
}

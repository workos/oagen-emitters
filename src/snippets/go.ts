import type { EmitterContext, ResolvedOperation } from '@workos/oagen';
import { className, fieldName, methodName, trimMountedResourceFromMethod } from '../go/naming.js';
import type { ExampleBuilder } from './example-builder.js';
import { collectSnippetArgs, collectWrapperArgs, type SnippetArg } from './shared.js';
import type { SnippetEmitter } from './types.js';

const INDENT = '\t';

export const goSnippetEmitter: SnippetEmitter = {
  language: 'go',
  fileExtension: 'go',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder) return null;

    // Mirror the Go SDK's naming pipeline: PascalCase the resolved method
    // name (or the wrapper name for split ops), then trim any mount-target
    // resource words from the end so `CreateOrganization` on `Organizations`
    // becomes `Create`. We compute these directly from the resolved op so
    // the snippet emitter does not depend on a fresh `buildResolvedLookup`
    // (which would re-validate the entire spec for uniqueness).
    const rawMethodName =
      resolved.wrappers && resolved.wrappers.length > 0 ? resolved.wrappers[0]!.name : resolved.methodName;
    const method = trimMountedResourceFromMethod(methodName(rawMethodName), resolved.mountOn);

    return renderCall(resolved, ctx, examples, method);
  },
};

function renderCall(
  resolved: ResolvedOperation,
  ctx: EmitterContext,
  examples: ExampleBuilder,
  method: string,
): string {
  const accessorMethod = className(resolved.mountOn);
  const optsTypeName = `${accessorMethod}${method}Params`;

  let args: SnippetArg[];
  let pathArgs: SnippetArg[];
  let bodyAndQueryArgs: SnippetArg[];

  if (resolved.wrappers && resolved.wrappers.length > 0) {
    args = collectWrapperArgs(resolved.wrappers[0]!, ctx, examples);
    pathArgs = [];
    bodyAndQueryArgs = args;
  } else {
    const collected = collectSnippetArgs(resolved, ctx, examples);
    args = collected.args;
    pathArgs = args.filter((a) => a.source === 'path');
    bodyAndQueryArgs = args.filter((a) => a.source !== 'path');
  }

  const lines: string[] = [];
  lines.push('package main');
  lines.push('');
  lines.push('import (');
  lines.push(`${INDENT}"context"`);
  lines.push('');
  lines.push(`${INDENT}"github.com/workos/workos-go/v9"`);
  lines.push(')');
  lines.push('');
  lines.push('func main() {');
  lines.push(`${INDENT}client := workos.NewClient("sk_example_123456789")`);
  lines.push('');

  // Build the method call. Go SDK methods take (ctx, positional path params..., *OptsStruct).
  const callParts: string[] = ['context.Background()'];
  for (const p of pathArgs) {
    callParts.push(renderValue(p.value));
  }

  if (bodyAndQueryArgs.length === 0) {
    lines.push(`${INDENT}_, err := client.${accessorMethod}().${method}(${callParts.join(', ')})`);
  } else {
    const optsLines = buildOptsStruct(optsTypeName, bodyAndQueryArgs);
    callParts.push(optsLines);
    const joined = callParts.length === 2 ? callParts.join(', ') : callParts.join(', ');
    lines.push(`${INDENT}_, err := client.${accessorMethod}().${method}(${joined})`);
  }
  lines.push(`${INDENT}if err != nil {`);
  lines.push(`${INDENT}${INDENT}panic(err)`);
  lines.push(`${INDENT}}`);
  lines.push('}');

  return lines.join('\n');
}

function buildOptsStruct(typeName: string, args: SnippetArg[]): string {
  const lines: string[] = [`&workos.${typeName}{`];
  for (const a of args) {
    const field = fieldName(a.wireName);
    const value = renderValue(a.value);
    const indentedValue = indentContinuationLines(value, `${INDENT}${INDENT}`);
    lines.push(`${INDENT}${INDENT}${field}: ${indentedValue},`);
  }
  lines.push(`${INDENT}}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Go literal rendering
// ---------------------------------------------------------------------------

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return goString(value);
  if (Array.isArray(value)) return renderSlice(value);
  if (typeof value === 'object') return renderStruct(value as Record<string, unknown>);
  return 'nil';
}

function goString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderSlice(items: unknown[]): string {
  if (items.length === 0) return '[]any{}';
  const rendered = items.map((v) => renderValue(v));
  const oneline = `[]any{${rendered.join(', ')}}`;
  if (oneline.length <= 80 && rendered.every((r) => !r.includes('\n'))) return oneline;
  const lines: string[] = ['[]any{'];
  for (const r of rendered) {
    lines.push(`${INDENT}${indentContinuationLines(r, INDENT)},`);
  }
  lines.push('}');
  return lines.join('\n');
}

function renderStruct(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return 'map[string]any{}';
  const rendered = entries.map(([k, v]) => ({ key: k, value: renderValue(v) }));
  const oneline = `map[string]any{${rendered.map((e) => `"${e.key}": ${e.value}`).join(', ')}}`;
  if (oneline.length <= 80 && rendered.every((e) => !e.value.includes('\n'))) return oneline;
  const lines: string[] = ['map[string]any{'];
  for (const e of rendered) {
    lines.push(`${INDENT}"${e.key}": ${indentContinuationLines(e.value, INDENT)},`);
  }
  lines.push('}');
  return lines.join('\n');
}

function indentContinuationLines(s: string, indent: string): string {
  if (!s.includes('\n')) return s;
  const lines = s.split('\n');
  return lines.map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n');
}

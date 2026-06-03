import type { EmitterContext, ExampleBuilder, ResolvedOperation, SnippetArg, SnippetEmitter } from '@workos/oagen';
import { collectSnippetArgs, collectWrapperArgs } from '@workos/oagen';
import { apiClassName, methodName, packageSegment, propertyName } from '../kotlin/naming.js';

const INDENT = '    ';

/**
 * Emits Java-syntax snippets (rendered as `.java`) backed by the Kotlin SDK's
 * naming so JVM callers see the same method and options names whether they
 * write Kotlin or Java. The WorkOS docs render the `.java` extension because
 * Java is the most common JVM consumer; Kotlin call sites would look almost
 * identical apart from `var`/`val` and named-argument syntax.
 */
export const kotlinSnippetEmitter: SnippetEmitter = {
  language: 'java',
  fileExtension: 'java',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder) return null;

    const method =
      resolved.wrappers && resolved.wrappers.length > 0
        ? methodName(resolved.wrappers[0]!.name)
        : methodName(resolved.methodName);

    return renderCall(resolved, ctx, examples, method);
  },
};

function renderCall(
  resolved: ResolvedOperation,
  ctx: EmitterContext,
  examples: ExampleBuilder,
  method: string,
): string {
  const apiClass = apiClassName(resolved.mountOn);
  const accessor = propertyName(resolved.mountOn);
  const optionsType = `${methodName(
    resolved.wrappers && resolved.wrappers.length > 0 ? resolved.wrappers[0]!.name : resolved.methodName,
  )}Options`;
  const optionsTypeCapitalized = optionsType[0]!.toUpperCase() + optionsType.slice(1);
  const apiSubPackage = packageSegment(resolved.mountOn);

  let args: SnippetArg[];
  let pathArgs: SnippetArg[];
  let optionsArgs: SnippetArg[];

  if (resolved.wrappers && resolved.wrappers.length > 0) {
    args = collectWrapperArgs(resolved.wrappers[0]!, ctx, examples);
    pathArgs = [];
    optionsArgs = args;
  } else {
    const collected = collectSnippetArgs(resolved, ctx, examples);
    args = collected.args;
    pathArgs = args.filter((a) => a.source === 'path');
    optionsArgs = args.filter((a) => a.source !== 'path');
  }

  const lines: string[] = [];
  lines.push('import com.workos.WorkOS;');
  if (optionsArgs.length > 0) {
    lines.push(`import com.workos.${apiSubPackage}.${apiClass}Api.${optionsTypeCapitalized};`);
  }
  lines.push('');
  lines.push('WorkOS workos = new WorkOS("sk_example_123456789");');
  lines.push('');

  const callParts: string[] = pathArgs.map((p) => renderValue(p.value));

  if (optionsArgs.length > 0) {
    lines.push(`${optionsTypeCapitalized} options = ${optionsTypeCapitalized}.builder()`);
    for (const a of optionsArgs) {
      const prop = propertyName(a.wireName);
      const value = renderValue(a.value);
      const indentedValue = indentContinuationLines(value, INDENT);
      lines.push(`${INDENT}.${prop}(${indentedValue})`);
    }
    lines.push(`${INDENT}.build();`);
    lines.push('');
    callParts.push('options');
  }

  if (callParts.length === 0) {
    lines.push(`workos.${accessor}.${method}();`);
  } else {
    lines.push(`workos.${accessor}.${method}(${callParts.join(', ')});`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Java literal rendering
// ---------------------------------------------------------------------------

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return javaString(value);
  if (Array.isArray(value)) return renderList(value);
  if (typeof value === 'object') return renderMap(value as Record<string, unknown>);
  return 'null';
}

function javaString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderList(items: unknown[]): string {
  if (items.length === 0) return 'List.of()';
  const rendered = items.map((v) => renderValue(v));
  const oneline = `List.of(${rendered.join(', ')})`;
  if (oneline.length <= 80 && rendered.every((r) => !r.includes('\n'))) return oneline;
  const lines: string[] = ['List.of('];
  for (let i = 0; i < rendered.length; i++) {
    const trailing = i < rendered.length - 1 ? ',' : '';
    lines.push(`${INDENT}${indentContinuationLines(rendered[i]!, INDENT)}${trailing}`);
  }
  lines.push(')');
  return lines.join('\n');
}

function renderMap(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return 'Map.of()';
  const rendered = entries.map(([k, v]) => ({ key: k, value: renderValue(v) }));
  const oneline = `Map.of(${rendered.map((e) => `"${e.key}", ${e.value}`).join(', ')})`;
  if (oneline.length <= 80 && rendered.every((e) => !e.value.includes('\n'))) return oneline;
  const lines: string[] = ['Map.of('];
  for (let i = 0; i < rendered.length; i++) {
    const e = rendered[i]!;
    const trailing = i < rendered.length - 1 ? ',' : '';
    lines.push(`${INDENT}"${e.key}", ${indentContinuationLines(e.value, INDENT)}${trailing}`);
  }
  lines.push(')');
  return lines.join('\n');
}

function indentContinuationLines(s: string, indent: string): string {
  if (!s.includes('\n')) return s;
  const lines = s.split('\n');
  return lines.map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n');
}

import type { EmitterContext, ExampleBuilder, ResolvedOperation, SnippetArg, SnippetEmitter } from '@workos/oagen';
import { collectSnippetArgs, collectWrapperArgs } from '@workos/oagen';
import { fieldName, methodName, moduleName, resourceAccessorName, typeName } from '../rust/naming.js';

const INDENT = '    ';

export const rustSnippetEmitter: SnippetEmitter = {
  language: 'rust',
  fileExtension: 'rs',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder) return null;

    const method = methodName(
      resolved.wrappers && resolved.wrappers.length > 0 ? resolved.wrappers[0]!.name : resolved.methodName,
    );

    return renderCall(resolved, ctx, examples, method);
  },
};

function renderCall(
  resolved: ResolvedOperation,
  ctx: EmitterContext,
  examples: ExampleBuilder,
  method: string,
): string {
  const accessor = resourceAccessorName(resolved.mountOn);
  const modulePath = moduleName(resolved.mountOn);
  const paramsStructName = `${typeName(
    resolved.wrappers && resolved.wrappers.length > 0 ? resolved.wrappers[0]!.name : resolved.methodName,
  )}Params`;

  let args: SnippetArg[];
  let pathArgs: SnippetArg[];
  let structArgs: SnippetArg[];

  if (resolved.wrappers && resolved.wrappers.length > 0) {
    args = collectWrapperArgs(resolved.wrappers[0]!, ctx, examples);
    pathArgs = [];
    structArgs = args;
  } else {
    const collected = collectSnippetArgs(resolved, ctx, examples);
    args = collected.args;
    pathArgs = args.filter((a) => a.source === 'path');
    structArgs = args.filter((a) => a.source !== 'path');
  }

  const imports: string[] = ['use workos::Client;'];
  if (structArgs.length > 0) {
    imports.push(`use workos::${modulePath}::${paramsStructName};`);
  }

  const lines: string[] = [];
  lines.push(...imports);
  lines.push('');
  lines.push('#[tokio::main]');
  lines.push('async fn main() -> Result<(), workos::Error> {');
  lines.push(`${INDENT}let client = Client::builder()`);
  lines.push(`${INDENT}${INDENT}.api_key("sk_example_123456789")`);
  lines.push(`${INDENT}${INDENT}.client_id("client_123456789")`);
  lines.push(`${INDENT}${INDENT}.build();`);
  lines.push('');

  const callParts: string[] = [];
  for (const p of pathArgs) {
    const v = p.value;
    if (typeof v === 'string') callParts.push(rustString(v));
    else callParts.push(renderValue(v));
  }
  if (structArgs.length > 0) {
    callParts.push(renderStructLiteral(paramsStructName, structArgs));
  }

  const callLines: string[] = [`${INDENT}let _result = client`, `${INDENT}${INDENT}.${accessor}()`];
  if (callParts.length === 0) {
    callLines.push(`${INDENT}${INDENT}.${method}()`);
  } else if (callParts.length === 1 && !callParts[0]!.includes('\n')) {
    callLines.push(`${INDENT}${INDENT}.${method}(${callParts[0]})`);
  } else {
    callLines.push(`${INDENT}${INDENT}.${method}(`);
    for (let i = 0; i < callParts.length; i++) {
      const trailing = i < callParts.length - 1 ? ',' : '';
      const indented = indentContinuationLines(callParts[i]!, `${INDENT}${INDENT}${INDENT}`);
      callLines.push(`${INDENT}${INDENT}${INDENT}${indented}${trailing}`);
    }
    callLines.push(`${INDENT}${INDENT})`);
  }
  callLines.push(`${INDENT}${INDENT}.await?;`);
  lines.push(...callLines);

  lines.push('');
  lines.push(`${INDENT}Ok(())`);
  lines.push('}');

  return lines.join('\n');
}

function renderStructLiteral(structName: string, args: SnippetArg[]): string {
  const lines: string[] = [`${structName} {`];
  for (const a of args) {
    const field = fieldName(a.wireName);
    const value = renderStructValue(a.value);
    lines.push(`${INDENT}${field}: ${indentContinuationLines(value, INDENT)},`);
  }
  lines.push(`${INDENT}..Default::default()`);
  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Rust literal rendering
// ---------------------------------------------------------------------------

/** Top-level value rendering (no `.into()` wrap — used for path params etc.). */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return rustString(value);
  if (Array.isArray(value)) return renderVec(value);
  if (typeof value === 'object') return renderInlineObject(value as Record<string, unknown>);
  return 'None';
}

/** Struct-field rendering: wraps strings with `.into()` so `String` fields accept &str. */
function renderStructValue(value: unknown): string {
  if (typeof value === 'string') return `${rustString(value)}.into()`;
  if (Array.isArray(value)) return renderVecStructValues(value);
  return renderValue(value);
}

function rustString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderVec(items: unknown[]): string {
  if (items.length === 0) return 'vec![]';
  const rendered = items.map((v) => renderValue(v));
  const oneline = `vec![${rendered.join(', ')}]`;
  if (oneline.length <= 80 && rendered.every((r) => !r.includes('\n'))) return oneline;
  const lines: string[] = ['vec!['];
  for (let i = 0; i < rendered.length; i++) {
    const trailing = i < rendered.length - 1 ? ',' : ',';
    lines.push(`${INDENT}${indentContinuationLines(rendered[i]!, INDENT)}${trailing}`);
  }
  lines.push(']');
  return lines.join('\n');
}

function renderVecStructValues(items: unknown[]): string {
  if (items.length === 0) return 'vec![]';
  const rendered = items.map((v) => renderStructValue(v));
  const oneline = `vec![${rendered.join(', ')}]`;
  if (oneline.length <= 80 && rendered.every((r) => !r.includes('\n'))) return oneline;
  const lines: string[] = ['vec!['];
  for (let i = 0; i < rendered.length; i++) {
    const trailing = i < rendered.length - 1 ? ',' : ',';
    lines.push(`${INDENT}${indentContinuationLines(rendered[i]!, INDENT)}${trailing}`);
  }
  lines.push(']');
  return lines.join('\n');
}

/** Render a plain object as a generic `serde_json::json!({...})` literal. The
 *  snippet doesn't know the exact Rust struct corresponding to each nested
 *  object, so we fall back to a serde-friendly literal a developer can swap
 *  for the concrete struct (e.g. `OrganizationDomainData { ... }`). */
function renderInlineObject(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return 'serde_json::json!({})';
  const rendered = entries.map(([k, v]) => ({ key: k, value: renderValue(v) }));
  const oneline = `serde_json::json!({ ${rendered.map((e) => `"${e.key}": ${e.value}`).join(', ')} })`;
  if (oneline.length <= 80 && rendered.every((e) => !e.value.includes('\n'))) return oneline;
  const lines: string[] = ['serde_json::json!({'];
  for (let i = 0; i < rendered.length; i++) {
    const e = rendered[i]!;
    const trailing = i < rendered.length - 1 ? ',' : ',';
    lines.push(`${INDENT}"${e.key}": ${indentContinuationLines(e.value, INDENT)}${trailing}`);
  }
  lines.push('})');
  return lines.join('\n');
}

function indentContinuationLines(s: string, indent: string): string {
  if (!s.includes('\n')) return s;
  const lines = s.split('\n');
  return lines.map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n');
}

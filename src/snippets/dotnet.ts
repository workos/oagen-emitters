import type { EmitterContext, ExampleBuilder, ResolvedOperation, SnippetArg, SnippetEmitter } from '@workos/oagen';
import { collectSnippetArgs, collectWrapperArgs } from '@workos/oagen';
import {
  appendAsyncSuffix,
  className,
  fieldName,
  methodName,
  trimMountedResourceFromMethod,
} from '../dotnet/naming.js';

const INDENT = '    ';

export const dotnetSnippetEmitter: SnippetEmitter = {
  language: 'dotnet',
  fileExtension: 'cs',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder) return null;

    // Mirror the .NET SDK's naming pipeline directly from the resolved op:
    // PascalCase → trim mount-target resource → append Async. We avoid
    // calling back into resolveMethodName so the snippet emitter does not
    // re-validate the whole resolved-ops set on every invocation.
    const rawMethodName =
      resolved.wrappers && resolved.wrappers.length > 0 ? resolved.wrappers[0]!.name : resolved.methodName;
    const stem = trimMountedResourceFromMethod(methodName(rawMethodName), resolved.mountOn);
    const method = appendAsyncSuffix(stem);

    return renderCall(resolved, ctx, examples, method);
  },
};

function renderCall(
  resolved: ResolvedOperation,
  ctx: EmitterContext,
  examples: ExampleBuilder,
  method: string,
): string {
  const accessor = className(resolved.mountOn);
  // Options class follows the `{Resource}{Method}Options` convention used by
  // the SDK (e.g. OrganizationsCreateOptions). The method here already had its
  // resource prefix trimmed and Async suffix appended, so reconstruct.
  const stem = method.replace(/Async$/, '');
  const optsType = `${accessor}${stem}Options`;

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
  lines.push('using WorkOS;');
  lines.push('');
  lines.push('var client = new WorkOSClient(new WorkOSOptions');
  lines.push('{');
  lines.push(`${INDENT}ApiKey = "sk_example_123456789",`);
  lines.push(`${INDENT}ClientId = "client_123456789",`);
  lines.push('});');
  lines.push('');

  const callParts: string[] = [];
  for (const p of pathArgs) callParts.push(renderValue(p.value));
  if (optionsArgs.length > 0) callParts.push(renderOptions(optsType, optionsArgs));

  const lhs = `await client.${accessor}.${method}`;
  if (callParts.length === 0) {
    lines.push(`${lhs}();`);
  } else if (callParts.length === 1) {
    lines.push(`${lhs}(${indentContinuationLines(callParts[0]!, INDENT)});`);
  } else {
    lines.push(`${lhs}(`);
    for (let i = 0; i < callParts.length; i++) {
      const trailing = i < callParts.length - 1 ? ',' : '';
      lines.push(`${INDENT}${indentContinuationLines(callParts[i]!, INDENT)}${trailing}`);
    }
    lines.push(');');
  }

  return lines.join('\n');
}

function renderOptions(typeName: string, args: SnippetArg[]): string {
  const lines: string[] = [`new ${typeName}`, '{'];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const field = fieldName(a.wireName);
    const value = renderValue(a.value);
    const trailing = i < args.length - 1 ? ',' : ',';
    lines.push(`${INDENT}${field} = ${indentContinuationLines(value, INDENT)}${trailing}`);
  }
  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// C# literal rendering
// ---------------------------------------------------------------------------

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return csharpString(value);
  if (Array.isArray(value)) return renderArray(value);
  if (typeof value === 'object') return renderDict(value as Record<string, unknown>);
  return 'null';
}

function csharpString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderArray(items: unknown[]): string {
  if (items.length === 0) return 'new[] { }';
  const rendered = items.map((v) => renderValue(v));
  const oneline = `new[] { ${rendered.join(', ')} }`;
  if (oneline.length <= 80 && rendered.every((r) => !r.includes('\n'))) return oneline;
  const lines: string[] = ['new[]', '{'];
  for (let i = 0; i < rendered.length; i++) {
    const trailing = i < rendered.length - 1 ? ',' : ',';
    lines.push(`${INDENT}${indentContinuationLines(rendered[i]!, INDENT)}${trailing}`);
  }
  lines.push('}');
  return lines.join('\n');
}

function renderDict(obj: Record<string, unknown>): string {
  // Plain dictionary literal — the dotnet SDK exposes models, but the snippet
  // doesn't know which model class corresponds to each nested object. Emit a
  // Dictionary<string, object> initializer that the SDK serializer can handle
  // or a developer can replace with the typed model.
  const entries = Object.entries(obj);
  if (entries.length === 0) return 'new Dictionary<string, object>()';
  const rendered = entries.map(([k, v]) => ({ key: k, value: renderValue(v) }));
  const lines: string[] = ['new Dictionary<string, object>', '{'];
  for (let i = 0; i < rendered.length; i++) {
    const e = rendered[i]!;
    const trailing = i < rendered.length - 1 ? ',' : ',';
    lines.push(`${INDENT}{ "${e.key}", ${indentContinuationLines(e.value, INDENT)} }${trailing}`);
  }
  lines.push('}');
  return lines.join('\n');
}

function indentContinuationLines(s: string, indent: string): string {
  if (!s.includes('\n')) return s;
  const lines = s.split('\n');
  return lines.map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n');
}

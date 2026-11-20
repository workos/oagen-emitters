import type {
  EmitterContext,
  ExampleBuilder,
  Model,
  Operation,
  ResolvedOperation,
  ResolvedWrapper,
  SnippetArg,
  SnippetEmitter,
  TypeRef,
} from '@workos/oagen';
import { collectSnippetArgs, collectWrapperArgs, planOperation } from '@workos/oagen';
import { className, domainFieldName, fieldName, methodName, trimMountedResourceFromMethod } from '../go/naming.js';
import {
  deriveVariantFieldName,
  groupVariantTypeName,
  makeOptional,
  mapQueryParamType,
  paramsStructName,
  reservedTypeNames,
  sortPathParamsByTemplateOrder,
} from '../go/resources.js';
import { mapTypeRef, mapTypeRefValue } from '../go/type-map.js';
import { wrapperParamGoType } from '../go/wrappers.js';
import {
  buildHiddenParams,
  collectBodyFieldTypes,
  collectGroupedParamNames,
  groupTypeBaseName,
} from '../shared/resolved-ops.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';

const INDENT = '\t';
const SDK_IMPORT = 'github.com/workos/workos-go/v10';
const MAX_INLINE = 80;

/**
 * Go call-site snippets for the generated workos-go SDK.
 *
 * Every name and type here comes from the Go SDK emitter (`src/go/`), so a
 * snippet compiles against the SDK generated from the same spec: params
 * struct names, positional path params, typed struct literals for models,
 * pointer helpers for optional scalars, `*Iterator[T]` for paginated lists,
 * and the `error`-only return of delete and void operations.
 */
export const goSnippetEmitter: SnippetEmitter = {
  language: 'go',
  fileExtension: 'go',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder) return null;
    if (resolved.wrappers && resolved.wrappers.length > 0) {
      return renderWrapperCall(resolved, resolved.wrappers[0]!, ctx, examples);
    }
    return renderOperationCall(resolved, ctx, examples);
  },
};

// ---------------------------------------------------------------------------
// Call rendering
// ---------------------------------------------------------------------------

type ReturnShape = 'iterator' | 'value' | 'error';

interface CallPlan {
  accessor: string;
  method: string;
  pathArgs: Node[];
  params: Node | null;
  returns: ReturnShape;
}

function renderOperationCall(resolved: ResolvedOperation, ctx: EmitterContext, examples: ExampleBuilder): string {
  const op = resolved.operation;
  const mountName = resolved.mountOn;
  // Mirror the Go SDK's naming pipeline: PascalCase the resolved method name,
  // then trim mount-target resource words from the end so
  // `CreateOrganization` on `Organizations` becomes `Create`.
  const method = trimMountedResourceFromMethod(methodName(resolved.methodName), mountName);
  const plan = planOperation(op);
  const hidden = buildHiddenParams(resolved);
  const grouped = collectGroupedParamNames(op);
  const { args } = collectSnippetArgs(resolved, ctx, examples);

  const pathArgs = renderPathArgs(op, args, ctx, examples);

  // The SDK takes a params struct whenever the operation has a visible body
  // field, a visible query param, or a parameter group, even if none of them
  // is required. Snippets must pass it too or the call has too few arguments.
  const bodyModel = op.requestBody?.kind === 'model' ? findModel(ctx, op.requestBody.name) : undefined;
  const hasVisibleBody = op.requestBody
    ? op.requestBody.kind === 'model'
      ? (bodyModel?.fields.some((f) => !hidden.has(f.name) && !grouped.has(f.name)) ?? false)
      : true
    : false;
  const hasVisibleQuery = op.queryParams.some((q) => !hidden.has(q.name) && !grouped.has(q.name));
  const groups = op.parameterGroups ?? [];
  const hasParams = hasVisibleBody || hasVisibleQuery || groups.length > 0;

  let params: Node | null = null;
  if (hasParams) {
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const a of args) {
      if (a.source === 'path' || grouped.has(a.wireName)) continue;
      const entry = a.source === 'body' ? bodyFieldEntry(a, ctx) : queryParamEntry(a, ctx);
      if (!entry || seen.has(entry.key!)) continue;
      seen.add(entry.key!);
      entries.push(entry);
    }
    if (op.requestBody && op.requestBody.kind !== 'model') {
      // Non-model bodies surface as `Body interface{}` on the params struct.
      entries.push({ key: 'Body', value: untyped(examples.forType(op.requestBody)) });
    }
    for (const group of groups) {
      if (group.optional) continue;
      const entry = groupEntry(op, mountName, group, ctx, examples);
      if (entry) entries.push(entry);
    }
    params = composite(`&workos.${paramsStructName(mountName, method)}`, entries);
  }

  let returns: ReturnShape;
  if (plan.isPaginated && op.pagination) returns = 'iterator';
  else if (plan.isDelete) returns = 'error';
  else if (plan.responseModelName) returns = 'value';
  else returns = 'error';

  return renderProgram({ accessor: className(mountName), method, pathArgs, params, returns });
}

function renderWrapperCall(
  resolved: ResolvedOperation,
  wrapper: ResolvedWrapper,
  ctx: EmitterContext,
  examples: ExampleBuilder,
): string {
  const op = resolved.operation;
  const mountName = resolved.mountOn;
  // Wrapper methods keep their full name (e.g. AuthenticateWithPassword); the
  // SDK does not trim the mount noun from them.
  const method = methodName(wrapper.name);
  const args = collectWrapperArgs(wrapper, ctx, examples);
  const wrapperParams = new Map(resolveWrapperParams(wrapper, ctx).map((p) => [p.paramName, p]));

  const entries: Entry[] = [];
  for (const a of args) {
    const param = wrapperParams.get(a.wireName);
    const field = param?.field ?? a.field;
    // Wrapper params structs type their fields with the wrapper emitter's
    // simplified mapping, not mapTypeRef.
    const goType = wrapperParamGoType(field, param?.isOptional ?? false);
    entries.push({ key: fieldName(a.wireName), value: renderTyped(a.value, field?.type, goType, ctx) });
  }

  return renderProgram({
    accessor: className(mountName),
    method,
    pathArgs: renderPathArgs(op, [], ctx, examples),
    params: composite(`&workos.${paramsStructName(mountName, method)}`, entries),
    returns: wrapper.responseModelName ? 'value' : 'error',
  });
}

function renderPathArgs(op: Operation, args: SnippetArg[], ctx: EmitterContext, examples: ExampleBuilder): Node[] {
  // The SDK takes every path param positionally, in URL-template order.
  return sortPathParamsByTemplateOrder(op).map((p) => {
    const arg = args.find((a) => a.source === 'path' && a.wireName === p.name);
    const value = arg ? arg.value : examples.forParameter(p);
    return renderTyped(value, p.type, mapTypeRefValue(p.type), ctx);
  });
}

function bodyFieldEntry(arg: SnippetArg, ctx: EmitterContext): Entry | null {
  const field = arg.field;
  if (!field) return null;
  const base = mapTypeRef(field.type);
  const goType = field.required ? base : makeOptional(base);
  return { key: domainFieldName(field), value: renderTyped(arg.value, field.type, goType, ctx) };
}

function queryParamEntry(arg: SnippetArg, ctx: EmitterContext): Entry | null {
  const param = arg.parameter;
  if (!param) return null;
  const base = mapQueryParamType(param.name, param.type);
  const goType = param.required ? base : makeOptional(base);
  return { key: fieldName(param.name), value: renderTyped(arg.value, param.type, goType, ctx) };
}

function groupEntry(
  op: Operation,
  mountName: string,
  group: NonNullable<Operation['parameterGroups']>[number],
  ctx: EmitterContext,
  examples: ExampleBuilder,
): Entry | null {
  // A required group takes one of its variant structs; show the first.
  const variant = group.variants[0];
  if (!variant) return null;
  const typeName = groupVariantTypeName(mountName, groupTypeBaseName(group), variant.name, reservedTypeNames(ctx));
  const optionalNames = new Set(variant.optionalParameters ?? []);
  const bodyFieldTypes = collectBodyFieldTypes(op, ctx.spec.models);
  const members: Entry[] = [];
  for (const param of variant.parameters) {
    if (optionalNames.has(param.name)) continue;
    const type = bodyFieldTypes.get(param.name) ?? param.type;
    members.push({
      key: deriveVariantFieldName(param.name, group.name),
      value: renderTyped(examples.forParameter(param), type, mapTypeRefValue(type), ctx),
    });
  }
  return { key: fieldName(group.name), value: composite(`workos.${typeName}`, members) };
}

function renderProgram(plan: CallPlan): string {
  const callArgs: Node[] = [expr('context.Background()'), ...plan.pathArgs];
  if (plan.params) callArgs.push(plan.params);
  const assign = plan.returns === 'iterator' ? 'iter := ' : plan.returns === 'value' ? '_, err := ' : 'err := ';
  const call = format(callNode(`client.${plan.accessor}().${plan.method}`, callArgs), INDENT, assign.length);

  const imports = plan.returns === 'iterator' ? ['"context"', '"fmt"'] : ['"context"'];
  const lines: string[] = [];
  lines.push('package main');
  lines.push('');
  lines.push('import (');
  for (const i of imports) lines.push(`${INDENT}${i}`);
  lines.push('');
  lines.push(`${INDENT}"${SDK_IMPORT}"`);
  lines.push(')');
  lines.push('');
  lines.push('func main() {');
  lines.push(`${INDENT}client := workos.NewClient("sk_example_123456789")`);
  lines.push('');
  lines.push(`${INDENT}${assign}${call}`);
  if (plan.returns === 'iterator') {
    // List methods return a single *Iterator[T] that fetches pages lazily.
    lines.push(`${INDENT}for iter.Next() {`);
    lines.push(`${INDENT}${INDENT}fmt.Println(iter.Current())`);
    lines.push(`${INDENT}}`);
    lines.push(`${INDENT}if err := iter.Err(); err != nil {`);
  } else {
    lines.push(`${INDENT}if err != nil {`);
  }
  lines.push(`${INDENT}${INDENT}panic(err)`);
  lines.push(`${INDENT}}`);
  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Typed value rendering
// ---------------------------------------------------------------------------

/**
 * Render `value` as a Go expression assignable to `goType`, the type the Go
 * SDK emitter gives the field or parameter described by `type`.
 */
function renderTyped(value: unknown, type: TypeRef | undefined, goType: string, ctx: EmitterContext): Node {
  if (!type) return untypedFor(value, goType);
  if (value === null || value === undefined) return expr(zeroValue(goType));

  if (type.kind === 'nullable') return renderTyped(value, type.inner, goType, ctx);

  // Optional scalars, enums and interface values are pointer-wrapped by the
  // SDK (makeOptional). Render the value, then take its address.
  const valueType = mapTypeRef(type);
  if (goType !== valueType && goType === `*${valueType}`) {
    return pointerTo(renderTyped(value, type, valueType, ctx), valueType);
  }

  switch (type.kind) {
    case 'primitive':
      return renderPrimitive(value, type.type, type.format, goType);
    case 'literal':
      return renderScalar(type.value ?? value, goType);
    case 'enum':
      return renderEnum(value, goType);
    case 'model':
      return renderModel(value, type.name, goType, ctx);
    case 'array': {
      if (!Array.isArray(value) || !goType.startsWith('[]')) return untypedFor(value, goType);
      const elemType = goType.slice(2);
      return composite(
        qualify(goType),
        value.map((v) => ({ value: elideType(renderTyped(v, type.items, elemType, ctx), elemType) })),
      );
    }
    case 'map': {
      if (!isPlainObject(value) || !goType.startsWith('map[string]')) return untypedFor(value, goType);
      const valueGoType = goType.slice('map[string]'.length);
      return composite(
        qualify(goType),
        Object.entries(value).map(([k, v]) => ({
          key: goString(k),
          value: elideType(renderTyped(v, type.valueType, valueGoType, ctx), valueGoType),
        })),
      );
    }
    case 'union': {
      // Render through the variant the SDK picked for this union's Go type.
      for (const variant of type.variants) {
        if (variant.kind === 'literal' && variant.value === null) continue;
        if (mapTypeRef(variant) === goType) return renderTyped(value, variant, goType, ctx);
      }
      return untypedFor(value, goType);
    }
    default:
      return untypedFor(value, goType);
  }
}

function renderPrimitive(value: unknown, kind: string, format: string | undefined, goType: string): Node {
  if (kind === 'unknown') return untyped(value);
  if (format === 'binary' && goType === '[]byte') return expr(`[]byte(${goString(String(value))})`);
  return renderScalar(value, goType);
}

function renderScalar(value: unknown, goType: string): Node {
  switch (goType) {
    case 'string':
      return expr(goString(typeof value === 'string' ? value : JSON.stringify(value)));
    case 'int':
      return expr(String(typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10) || 0));
    case 'float64':
      return expr(String(typeof value === 'number' ? value : Number.parseFloat(String(value)) || 0));
    case 'bool':
      return expr(value === true || value === 'true' ? 'true' : 'false');
    default:
      return untypedFor(value, goType);
  }
}

function renderEnum(value: unknown, goType: string): Node {
  // Enums are named string types; an explicit conversion keeps the literal
  // typed inside slices, maps and pointer helpers.
  const literal = typeof value === 'number' ? String(value) : goString(String(value));
  return expr(`${qualify(goType)}(${literal})`);
}

function renderModel(value: unknown, modelName: string, goType: string, ctx: EmitterContext): Node {
  const model = findModel(ctx, modelName);
  if (!model || !isPlainObject(value)) return untypedFor(value, goType);
  const isPointer = goType.startsWith('*');
  const typeName = `${isPointer ? '&' : ''}workos.${className(modelName)}`;
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const [wire, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const field = model.fields.find((f) => f.name === wire);
    // Example keys the model does not declare have no struct field to set.
    if (!field) continue;
    const goField = domainFieldName(field);
    if (seen.has(goField)) continue;
    seen.add(goField);
    const base = mapTypeRef(field.type);
    const fieldGoType = field.required ? base : makeOptional(base);
    entries.push({ key: goField, value: renderTyped(v, field.type, fieldGoType, ctx) });
  }
  return composite(typeName, entries);
}

/**
 * Drop a composite element's type when the enclosing slice or map literal
 * already implies it (`[]*workos.Target{{...}}`), as `gofmt -s` would.
 */
function elideType(node: Node, elemType: string): Node {
  if (node.kind !== 'composite') return node;
  const implied = elemType.startsWith('*') ? `&${qualify(elemType.slice(1))}` : qualify(elemType);
  return node.type === implied ? { ...node, type: '' } : node;
}

function pointerTo(inner: Node, valueType: string): Node {
  switch (valueType) {
    case 'string':
      return callNode('workos.String', [inner]);
    case 'int':
      return callNode('workos.Int', [inner]);
    case 'bool':
      return callNode('workos.Bool', [inner]);
    default:
      return callNode(`workos.Ptr[${qualify(valueType)}]`, [inner]);
  }
}

/** Untyped rendering for `interface{}` and `map[string]interface{}` targets. */
function untypedFor(value: unknown, goType: string): Node {
  if (value === null || value === undefined) return expr(zeroValue(goType));
  return untyped(value);
}

function untyped(value: unknown): Node {
  if (value === null || value === undefined) return expr('nil');
  if (typeof value === 'boolean') return expr(value ? 'true' : 'false');
  if (typeof value === 'number') return expr(String(value));
  if (typeof value === 'string') return expr(goString(value));
  if (Array.isArray(value))
    return composite(
      '[]interface{}',
      value.map((v) => ({ value: untyped(v) })),
    );
  if (isPlainObject(value)) {
    return composite(
      'map[string]interface{}',
      Object.entries(value).map(([k, v]) => ({ key: goString(k), value: untyped(v) })),
    );
  }
  return expr('nil');
}

function zeroValue(goType: string): string {
  if (goType === 'string') return '""';
  if (goType === 'int' || goType === 'float64') return '0';
  if (goType === 'bool') return 'false';
  return 'nil';
}

/** Package-qualify exported type names in a Go type expression. */
function qualify(goType: string): string {
  return goType.replace(/\b([A-Z]\w*)/g, 'workos.$1');
}

function goString(s: string): string {
  return JSON.stringify(s);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findModel(ctx: EmitterContext, name: string): Model | undefined {
  return ctx.spec.models.find((m) => m.name === name);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type Node =
  | { kind: 'expr'; text: string }
  | { kind: 'composite'; type: string; entries: Entry[] }
  | { kind: 'call'; fn: string; args: Node[] };

interface Entry {
  key?: string;
  value: Node;
}

function expr(text: string): Node {
  return { kind: 'expr', text };
}

function composite(type: string, entries: Entry[]): Node {
  return { kind: 'composite', type, entries };
}

function callNode(fn: string, args: Node[]): Node {
  return { kind: 'call', fn, args };
}

/**
 * Render a node. `indent` is the indentation of the line the node starts on
 * and `offset` the width of whatever precedes it on that line.
 */
function format(node: Node, indent: string, offset = 0): string {
  const inline = formatInline(node);
  if (inline !== null && indentWidth(indent) + offset + inline.length <= MAX_INLINE) return inline;
  switch (node.kind) {
    case 'expr':
      return node.text;
    case 'composite':
      return formatBlock(node, indent);
    case 'call': {
      // Keep leading scalar args on the call line and break the last argument
      // (usually the params struct) across lines.
      const head = node.args.slice(0, -1).map((a) => formatInline(a) ?? format(a, indent));
      const last = node.args[node.args.length - 1];
      const tail = !last ? '' : last.kind === 'composite' ? formatBlock(last, indent) : format(last, indent);
      return `${node.fn}(${[...head, tail].filter((s) => s !== '').join(', ')})`;
    }
  }
}

/** A composite literal with one entry per line. */
function formatBlock(node: Extract<Node, { kind: 'composite' }>, indent: string): string {
  if (node.entries.length === 0) return `${node.type}{}`;
  const inner = indent + INDENT;
  const lines = node.entries.map((e) => {
    const key = e.key !== undefined ? `${e.key}: ` : '';
    return `${inner}${key}${format(e.value, inner, key.length)},`;
  });
  return `${node.type}{\n${lines.join('\n')}\n${indent}}`;
}

function indentWidth(indent: string): number {
  // gofmt indents with tabs; count each as four columns.
  return indent.length * 4;
}

function formatInline(node: Node): string | null {
  switch (node.kind) {
    case 'expr':
      return node.text.includes('\n') ? null : node.text;
    case 'composite': {
      const parts: string[] = [];
      for (const e of node.entries) {
        const v = formatInline(e.value);
        if (v === null) return null;
        parts.push(e.key !== undefined ? `${e.key}: ${v}` : v);
      }
      return `${node.type}{${parts.join(', ')}}`;
    }
    case 'call': {
      const parts: string[] = [];
      for (const a of node.args) {
        const v = formatInline(a);
        if (v === null) return null;
        parts.push(v);
      }
      return `${node.fn}(${parts.join(', ')})`;
    }
  }
}

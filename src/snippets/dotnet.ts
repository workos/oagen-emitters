import type {
  EmitterContext,
  Enum,
  ExampleBuilder,
  Field,
  Model,
  Operation,
  ParameterGroup,
  ResolvedOperation,
  SnippetArg,
  SnippetEmitter,
  TypeRef,
} from '@workos/oagen';
import { collectSnippetArgs, collectWrapperArgs } from '@workos/oagen';
import { dotnetEmitter, prepareDotnetModels } from '../dotnet/index.js';
import { enumMemberName } from '../dotnet/enums.js';
import { modelPropertyName, singleValueConstInitializer } from '../dotnet/models.js';
import {
  appendAsyncSuffix,
  className,
  fieldName,
  methodName,
  modelClassName,
  resolveMethodName,
  resolveMethodStem,
} from '../dotnet/naming.js';
import { planOptionsParam, resolveGroupClassNames, sortPathParamsByTemplateOrder } from '../dotnet/resources.js';
import { mapTypeRef, resolveEnumTypeName, resolveModelName } from '../dotnet/type-map.js';
import { collectGroupedParamNames } from '../shared/resolved-ops.js';
import { bearerOverrideScheme } from '../shared/security.js';
import { getSyntheticEnums } from '../shared/model-utils.js';

const INDENT = '    ';
/** Longest initializer kept on one line. */
const INLINE_WIDTH = 80;

/**
 * C# call-site snippets for the generated workos-dotnet SDK.
 *
 * Every name and type comes from the .NET SDK emitter (`src/dotnet/`), so a
 * snippet compiles against the SDK generated from the same spec: methods take
 * their path parameters, then the bearer token an operation authenticates
 * with, then the options object (always passed when the SDK requires it).
 * Values are typed like the options and model properties they fill: enums are
 * enum members, lists `List<T>`, maps `Dictionary<string, T>`, timestamps
 * `DateTimeOffset` and nested objects the model classes.
 */
export const dotnetSnippetEmitter: SnippetEmitter = {
  language: 'dotnet',
  fileExtension: 'cs',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder) return null;
    const r = new Renderer(ctx, examples, dotnetState(ctx));
    const call = resolved.wrappers?.length ? r.wrapperCall(resolved) : r.operationCall(resolved);
    return program(`client.${className(resolved.mountOn)}.${call.method}`, call.args);
  },
};

interface DotnetState {
  /** Models as the SDK emits them, keyed by spec name. */
  models: Map<string, Model>;
  enums: Map<string, Enum>;
  /** Discriminated base model → its discriminator property. */
  discriminatorProperties: Map<string, string>;
  /** Single-value enum name → its value, for fields the SDK sets itself. */
  enumConstByName: Map<string, string>;
}

const stateCache = new WeakMap<object, DotnetState>();

/**
 * Generate the SDK's enums and models once per spec. Generation publishes the
 * enum and model aliases that `mapTypeRef` resolves names through, so the
 * snippets name types the way the SDK does.
 */
function dotnetState(ctx: EmitterContext): DotnetState {
  let state = stateCache.get(ctx.spec);
  if (!state) {
    dotnetEmitter.generateEnums(ctx.spec.enums, ctx);
    dotnetEmitter.generateModels(ctx.spec.models, ctx);
    const prepared = prepareDotnetModels(ctx.spec.models);
    const enums = [...ctx.spec.enums, ...getSyntheticEnums()];
    state = {
      models: new Map(prepared.models.map((m) => [m.name, m])),
      enums: new Map(enums.map((e) => [e.name, e])),
      discriminatorProperties: prepared.discCtx.discriminatorProperties ?? new Map(),
      enumConstByName: new Map(
        ctx.spec.enums.filter((e) => e.values.length === 1).map((e) => [e.name, String(e.values[0]!.value)]),
      ),
    };
    stateCache.set(ctx.spec, state);
  }
  return state;
}

interface Call {
  method: string;
  args: string[];
}

/** One property assignment in an object initializer. */
interface Assignment {
  name: string;
  value: string;
}

class Renderer {
  constructor(
    private readonly ctx: EmitterContext,
    private readonly examples: ExampleBuilder,
    private readonly state: DotnetState,
  ) {}

  operationCall(resolved: ResolvedOperation): Call {
    const op = resolved.operation;
    const mount = { name: resolved.mountOn, operations: [op] };
    const stem = resolveMethodStem(op, mount, this.ctx);
    const { args } = collectSnippetArgs(resolved, this.ctx, this.examples);

    const callArgs = this.pathArgs(op, args);
    const bearer = bearerOverrideScheme(op);
    if (bearer) callArgs.push(csString(`${bearer}_example`));

    const options = planOptionsParam(op, resolved.mountOn, stem, this.ctx, resolved);
    if (options) {
      const grouped = collectGroupedParamNames(op);
      const assignments: Assignment[] = [];
      for (const a of args) {
        if (a.source === 'path' || grouped.has(a.wireName)) continue;
        assignments.push({ name: fieldName(a.wireName), value: this.value(a.value, argType(a)) });
      }
      assignments.push(...this.groups(op, resolved.mountOn, args));
      if (options.required || assignments.length > 0) {
        callArgs.push(initializer(options.optionsClass, assignments));
      }
    }

    return { method: resolveMethodName(op, mount, this.ctx), args: callArgs };
  }

  wrapperCall(resolved: ResolvedOperation): Call {
    const op = resolved.operation;
    const wrapper = resolved.wrappers![0]!;
    const stem = methodName(wrapper.name);
    const args = collectWrapperArgs(wrapper, this.ctx, this.examples);
    const callArgs = this.pathArgs(op, []);
    const assignments = args.map((a) => ({ name: fieldName(a.wireName), value: this.value(a.value, argType(a)) }));
    callArgs.push(initializer(`${stem}Options`, assignments));
    return { method: appendAsyncSuffix(stem), args: callArgs };
  }

  /** Path parameters in the order the SDK method declares them. */
  private pathArgs(op: Operation, args: SnippetArg[]): string[] {
    return sortPathParamsByTemplateOrder(op).map((p) => {
      const arg = args.find((a) => a.source === 'path' && a.wireName === p.name);
      return csString(String(arg ? arg.value : this.examples.forParameter(p)));
    });
  }

  /**
   * Options properties for parameter groups: a group the caller must set gets
   * its first variant, filled from the snippet's arguments or examples.
   */
  private groups(op: Operation, mountName: string, args: SnippetArg[]): Assignment[] {
    const groups = op.parameterGroups ?? [];
    if (groups.length === 0) return [];
    const names = resolveGroupClassNames(mountName, [op], this.ctx);
    const out: Assignment[] = [];
    for (const group of groups) {
      const variant = pickVariant(group, args);
      if (!variant) continue;
      const classes = [...names.values()].find((n) => n.variants.has(variant.name));
      const variantClass = classes?.variants.get(variant.name);
      if (!variantClass) continue;
      const optional = new Set(variant.optionalParameters ?? []);
      const members: Assignment[] = [];
      for (const p of variant.parameters) {
        const arg = args.find((a) => a.wireName === p.name);
        if (!arg && optional.has(p.name)) continue;
        const value = arg ? arg.value : this.examples.forParameter(p);
        members.push({ name: fieldName(p.name), value: this.value(value, p.type) });
      }
      out.push({ name: fieldName(group.name), value: initializer(variantClass, members) });
    }
    return out;
  }

  /** A C# expression of the type `type` maps to, holding `value`. */
  value(value: unknown, type: TypeRef): string {
    switch (type.kind) {
      case 'nullable':
        return value === null || value === undefined ? 'null' : this.value(value, type.inner);
      case 'primitive':
        return primitive(value, mapTypeRef(type));
      case 'literal':
        return raw(type.value);
      case 'enum':
        return this.enumValue(value, type.name, mapTypeRef(type));
      case 'array': {
        const items = Array.isArray(value) ? value : [];
        return collection(
          `List<${mapTypeRef(type.items)}>`,
          items.map((v) => this.value(v, type.items)),
        );
      }
      case 'map': {
        const entries = isRecord(value) ? Object.entries(value) : [];
        return collection(
          `Dictionary<string, ${mapTypeRef(type.valueType)}>`,
          entries.map(([k, v]) => `{ ${csString(k)}, ${this.value(v, type.valueType)} }`),
        );
      }
      case 'model':
        return this.model(value, type.name);
      case 'union':
        return this.union(value, type);
      default:
        return raw(value);
    }
  }

  private enumValue(value: unknown, name: string, cs: string): string {
    if (cs === 'string') return csString(String(value));
    const def = this.state.enums.get(resolveEnumTypeName(name)) ?? this.state.enums.get(name);
    const member = def ? enumMemberName(def, value) : undefined;
    return member ? `${cs}.${member}` : raw(value);
  }

  /** An object initializer for the model class `name` stands for. */
  private model(value: unknown, name: string): string {
    const canonical = resolveModelName(name);
    const cls = modelClassName(canonical);
    const model = this.state.models.get(canonical) ?? this.state.models.get(name);
    if (!model || !isRecord(value)) return `new ${cls}()`;
    const discriminator = this.state.discriminatorProperties.get(model.name);
    const assignments: Assignment[] = [];
    const seen = new Set<string>();
    for (const [wire, v] of Object.entries(value)) {
      const field = model.fields.find((f) => f.name === wire);
      if (!field || wire === discriminator || this.isConstField(field)) continue;
      const property = modelPropertyName(field, cls);
      if (seen.has(property)) continue;
      seen.add(property);
      assignments.push({ name: property, value: this.value(v, field.type) });
    }
    return initializer(cls, assignments);
  }

  /** A required single-value field the SDK initializes and keeps read-only. */
  private isConstField(field: Field): boolean {
    return field.required && singleValueConstInitializer(field.type, this.state.enumConstByName) !== null;
  }

  /**
   * A value for a union: the variant whose shape matches the example. `OneOf`
   * converts implicitly from each variant, and a discriminated union is typed
   * `object`.
   */
  private union(value: unknown, type: Extract<TypeRef, { kind: 'union' }>): string {
    const variants = type.variants;
    let pick: TypeRef | undefined;
    if (isRecord(value)) {
      const mapped = type.discriminator && value[type.discriminator.property];
      const target = typeof mapped === 'string' ? type.discriminator?.mapping[mapped] : undefined;
      pick =
        (target && variants.find((v) => v.kind === 'model' && v.name === target)) ||
        variants.find((v) => v.kind === 'model' || v.kind === 'map');
    } else if (Array.isArray(value)) {
      pick = variants.find((v) => v.kind === 'array');
    } else {
      pick = variants.find((v) => scalarMatches(v, value));
    }
    return pick ? this.value(value, pick) : raw(value);
  }
}

function argType(a: SnippetArg): TypeRef {
  return a.field?.type ?? a.parameter?.type ?? { kind: 'primitive', type: 'unknown' };
}

/** The variant whose parameters the snippet already sets, else the first when the group is required. */
function pickVariant(group: ParameterGroup, args: SnippetArg[]): ParameterGroup['variants'][number] | undefined {
  const wire = new Set(args.map((a) => a.wireName));
  const matched = group.variants.find((v) => v.parameters.some((p) => wire.has(p.name)));
  if (matched) return matched;
  return group.optional ? undefined : group.variants[0];
}

function scalarMatches(type: TypeRef, value: unknown): boolean {
  switch (type.kind) {
    case 'nullable':
      return scalarMatches(type.inner, value);
    case 'enum':
      return typeof value === 'string' && (type.values?.some((v) => v === value) ?? true);
    case 'literal':
      return type.value === value;
    case 'primitive':
      if (typeof value === 'string') return type.type === 'string';
      if (typeof value === 'number') return type.type === 'integer' || type.type === 'number';
      if (typeof value === 'boolean') return type.type === 'boolean';
      return false;
    default:
      return false;
  }
}

function primitive(value: unknown, cs: string): string {
  switch (cs) {
    case 'DateTimeOffset':
      return `DateTimeOffset.Parse(${csString(String(value))})`;
    case 'byte[]':
      return `System.Text.Encoding.UTF8.GetBytes(${csString(String(value))})`;
    case 'string':
      return csString(typeof value === 'string' ? value : JSON.stringify(value));
    case 'long':
    case 'int':
    case 'double':
      return typeof value === 'number' ? String(value) : '0';
    case 'bool':
      return value === true ? 'true' : 'false';
    default:
      return raw(value);
  }
}

/** An untyped value (`object`): scalars as literals, objects as dictionaries. */
function raw(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return csString(value);
  if (Array.isArray(value)) return collection('List<object>', value.map(raw));
  if (isRecord(value)) {
    return collection(
      'Dictionary<string, object>',
      Object.entries(value).map(([k, v]) => `{ ${csString(k)}, ${raw(v)} }`),
    );
  }
  return 'null';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function csString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** `new T { a, b }`, on one line when short, else one element per line. */
function collection(type: string, items: string[]): string {
  if (items.length === 0) return `new ${type}()`;
  const oneLine = `new ${type} { ${items.join(', ')} }`;
  if (oneLine.length <= INLINE_WIDTH && !oneLine.includes('\n')) return oneLine;
  return block(`new ${type}`, items);
}

/** `new T { A = a, B = b }`, one property per line. */
function initializer(type: string, assignments: Assignment[]): string {
  if (assignments.length === 0) return `new ${type}()`;
  return block(
    `new ${type}`,
    assignments.map((a) => `${a.name} = ${a.value}`),
  );
}

function block(head: string, items: string[]): string {
  const lines = [head, '{'];
  for (const item of items) lines.push(`${INDENT}${indent(item)},`);
  lines.push('}');
  return lines.join('\n');
}

function indent(s: string): string {
  return s.replace(/\n/g, `\n${INDENT}`);
}

function program(callee: string, args: string[]): string {
  const lines: string[] = [];
  lines.push('using WorkOS;');
  lines.push('');
  lines.push('var client = new WorkOSClient(new WorkOSOptions');
  lines.push('{');
  lines.push(`${INDENT}ApiKey = "sk_example_123456789",`);
  lines.push(`${INDENT}ClientId = "client_123456789",`);
  lines.push('});');
  lines.push('');

  const lhs = `await ${callee}`;
  if (args.length === 0) {
    lines.push(`${lhs}();`);
  } else if (args.length === 1 || args.slice(0, -1).every((a) => !a.includes('\n'))) {
    // Short leading arguments stay on the call line; a trailing initializer
    // opens on it too.
    lines.push(`${lhs}(${args.join(', ')});`);
  } else {
    lines.push(`${lhs}(`);
    args.forEach((a, i) => lines.push(`${INDENT}${indent(a)}${i < args.length - 1 ? ',' : ''}`));
    lines.push(');');
  }
  return lines.join('\n');
}

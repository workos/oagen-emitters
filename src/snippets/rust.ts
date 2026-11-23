import type {
  EmitterContext,
  Enum,
  ExampleBuilder,
  Model,
  Operation,
  ParameterGroup,
  ResolvedOperation,
  ResolvedWrapper,
  SnippetArg,
  SnippetEmitter,
  TypeRef,
} from '@workos/oagen';
import { collectSnippetArgs, collectWrapperArgs } from '@workos/oagen';
import { enrichModelsForRust } from '../rust/index.js';
import { generateModels, resolveFieldNames } from '../rust/models.js';
import { fieldName, methodName, moduleName, resourceAccessorName, typeName, variantName } from '../rust/naming.js';
import {
  GroupEmitter,
  bearerOverrideToken,
  ctorParams,
  generateResources,
  isEmptyParams,
  isEmptyResponse,
  paramsDefaultKind,
  planParamsStruct,
  planWrapperParamsStruct,
  type SyntheticBodySpec,
} from '../rust/resources.js';
import { applySecretRedaction } from '../rust/secret.js';
import { makeOptional, mapTypeRef, UnionRegistry } from '../rust/type-map.js';
import { getSyntheticEnums } from '../shared/model-utils.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';

const INDENT = '    ';
/** rustfmt's `max_width`. */
const MAX_WIDTH = 100;
/** rustfmt's `fn_call_width`: longer argument lists go one per line. */
const CALL_WIDTH = 60;

/**
 * Rust call-site snippets for the generated workos-rust SDK.
 *
 * Every name and type comes from the Rust SDK emitter (`src/rust/`), so a
 * snippet compiles against the SDK generated from the same spec: methods take
 * their path parameters, then a params struct (unless the operation has
 * none). Params structs with a required field are built with `new(…)` (pass
 * the shipped SDK's API surface as `ctx.apiSurface` to follow its argument
 * order), the others with `Default`; models, which have neither, are struct
 * literals that name every field.
 */
export const rustSnippetEmitter: SnippetEmitter = {
  language: 'rust',
  fileExtension: 'rs',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder) return null;
    const r = new Renderer(ctx, examples, rustState(ctx));
    const wrapper = resolved.wrappers?.[0];
    const call = wrapper ? r.wrapperCall(resolved, wrapper) : r.operationCall(resolved);
    return r.program(resolved, call);
  },
};

interface RustState {
  /** Inline unions the SDK synthesizes, registered under the SDK's names. */
  registry: UnionRegistry;
  models: Map<string, Model>;
  enums: Map<string, Enum>;
}

const stateCache = new WeakMap<object, RustState>();

/**
 * Generate the SDK's models and resources once per spec. Union names depend
 * on the order the SDK registers them, so replaying the generation is the
 * only way to name them the way the SDK does.
 */
function rustState(ctx: EmitterContext): RustState {
  let state = stateCache.get(ctx.spec);
  if (!state) {
    const registry = new UnionRegistry();
    const models = enrichModelsForRust(ctx.spec.models);
    const synthetic = getSyntheticEnums();
    generateModels(models, ctx, registry);
    generateResources(ctx.spec.services, ctx, registry);
    state = {
      registry,
      models: new Map(models.map((m) => [m.name, m])),
      enums: new Map([...ctx.spec.enums, ...synthetic].map((e) => [e.name, e])),
    };
    stateCache.set(ctx.spec, state);
  }
  return state;
}

interface Call {
  method: string;
  args: Node[];
  needsClientId: boolean;
}

/** A params-struct field, as the snippet needs it. */
interface Slot {
  fname: string;
  rust: string;
  required: boolean;
  /**
   * The value to pass; `null` leaves an optional field unset. `rust`
   * overrides the field's type, e.g. for a `new` argument that keeps the
   * inner type of a field that has since become optional.
   */
  value: (target: 'field' | 'ctor', rust?: string) => Node | null;
}

class Renderer {
  /** `use` paths, keyed by the module they come from (`''` = crate root). */
  private readonly imports = new Map<string, Set<string>>();

  constructor(
    private readonly ctx: EmitterContext,
    private readonly examples: ExampleBuilder,
    private readonly state: RustState,
  ) {}

  operationCall(resolved: ResolvedOperation): Call {
    const op = resolved.operation;
    const module = moduleName(resolved.mountOn);
    const { args } = collectSnippetArgs(resolved, this.ctx, this.examples);
    const byWire = new Map<string, SnippetArg>();
    for (const a of args) byWire.set(`${a.source}:${a.wireName}`, a);

    const callArgs: Node[] = op.pathParams.map((p) => {
      const arg = byWire.get(`path:${p.name}`);
      return str(String(arg ? arg.value : this.examples.forParameter(p)));
    });

    if (!isEmptyParams(op, resolved)) {
      const name = `${typeName(resolved.methodName)}Params`;
      const groups = new GroupEmitter();
      const fields = planParamsStruct(name, op, resolved, this.state.registry, this.ctx, groups);
      const bodyArgs = args.filter((a) => a.source === 'body');
      const slots: Slot[] = fields.map((f) => {
        const source = f.source;
        let value: Slot['value'];
        if (source.kind === 'param') {
          const arg = byWire.get(`query:${source.param.name}`);
          const type = source.param.type;
          value = (target, rust = f.rust) => {
            if (arg) return this.typed(arg.value, type, rust, target);
            if (f.required) return this.typed(this.examples.forParameter(source.param), type, rust, target);
            return null;
          };
        } else if (source.kind === 'group') {
          value = () => (f.required ? this.groupVariant(source.group, source.enumName, groups, module, byWire) : null);
        } else {
          value = (target, rust = f.rust) => this.body(op, rust, bodyArgs, groups, module, byWire, target, f.required);
        }
        return { fname: f.fname, rust: f.rust, required: f.required, value };
      });
      callArgs.push(this.params(name, module, slots));
    }

    const token = bearerOverrideToken(op);
    if (token) callArgs.push(str(`${token}_example`));

    return {
      method: methodName(resolved.methodName),
      args: callArgs,
      needsClientId: (resolved.inferFromClient ?? []).includes('client_id'),
    };
  }

  wrapperCall(resolved: ResolvedOperation, wrapper: ResolvedWrapper): Call {
    const op = resolved.operation;
    const module = moduleName(resolved.mountOn);
    const args = collectWrapperArgs(wrapper, this.ctx, this.examples);
    const byWire = new Map(args.map((a) => [a.wireName, a]));
    const callArgs: Node[] = op.pathParams.map((p) => str(String(this.examples.forParameter(p))));
    const name = `${typeName(wrapper.name)}Params`;
    const fields = planWrapperParamsStruct(
      name,
      resolveWrapperParams(wrapper, this.ctx),
      this.state.registry,
      this.ctx,
    );
    const slots: Slot[] = fields.map((f) => {
      const arg = byWire.get(f.param.paramName);
      const type: TypeRef = f.param.field?.type ?? { kind: 'primitive', type: 'string' };
      return {
        fname: f.fname,
        rust: f.rust,
        required: f.required,
        value: (target, rust = f.rust) => {
          if (arg) return this.typed(arg.value, type, rust, target);
          if (f.required) return this.typed(this.examples.forType(type), type, rust, target);
          return null;
        },
      };
    });
    callArgs.push(this.params(name, module, slots));
    const inferred = [...(wrapper.inferFromClient ?? []), ...(resolved.inferFromClient ?? [])];
    return { method: methodName(wrapper.name), args: callArgs, needsClientId: inferred.includes('client_id') };
  }

  /**
   * Build a params struct: `new(…)` when it has required fields (any optional
   * value goes through struct-update syntax), otherwise `Default`.
   */
  private params(name: string, module: string, slots: Slot[]): Node {
    this.use(module, name);
    const optional = slots
      .filter((s) => !s.required)
      .flatMap((s) => {
        const v = s.value('field');
        return v ? [{ name: s.fname, value: v }] : [];
      });
    if (paramsDefaultKind(slots.map((s) => ({ required: s.required, defaultExpr: null }))) !== 'none') {
      if (optional.length === 0) return expr(`${name}::default()`);
      return struct(name, optional, expr('Default::default()'));
    }
    // Follow the shipped `new(…)` signature when the surface describes this
    // SDK; another language's surface says nothing about it.
    const sdkCtx = this.ctx.apiSurface?.language === 'rust' ? this.ctx : { ...this.ctx, apiSurface: undefined };
    const ctor = ctorParams(
      name,
      slots.map((s) => ({ name: s.fname, rust: s.rust, required: s.required })),
      sdkCtx,
    );
    const bySlot = new Map(slots.map((s) => [s.fname, s]));
    const ctorArgs = ctor.map((p) => {
      const slot = bySlot.get(p.name)!;
      // A retained parameter takes the inner type of its now-optional field.
      const rust = p.retained ? unwrapOption(slot.rust) : slot.rust;
      return slot.value('ctor', rust) ?? this.placeholder(rust, 'ctor');
    });
    const built = call(`${name}::new`, ctorArgs);
    const inCtor = new Set(ctor.map((p) => p.name));
    const extra = optional.filter((o) => !inCtor.has(o.name));
    return extra.length === 0 ? built : struct(name, extra, built);
  }

  private body(
    op: Operation,
    rust: string,
    bodyArgs: SnippetArg[],
    groups: GroupEmitter,
    module: string,
    byWire: Map<string, SnippetArg>,
    target: 'field' | 'ctor',
    required: boolean,
  ): Node | null {
    const values = Object.fromEntries(bodyArgs.map((a) => [a.wireName, a.value]));
    const inner = unwrapOption(rust);
    const synthetic = groups.bodySpec(inner);
    if (synthetic) {
      const node = this.syntheticBody(op, synthetic, values, groups, module, byWire);
      return rust.startsWith('Option<') ? call('Some', [node]) : node;
    }
    if (!required && bodyArgs.length === 0) return null;
    const bodyType = op.requestBody?.kind === 'nullable' ? op.requestBody.inner : op.requestBody;
    if (!bodyType) return null;
    // Only a model body is spread into fields; any other body (an array, a
    // string, a map) is one value of its own shape.
    const value = bodyType.kind === 'model' ? values : this.examples.forType(bodyType);
    return this.typed(value, bodyType, rust, target);
  }

  /** A synthetic body: the body model's fields, with each parameter group as one enum field. */
  private syntheticBody(
    op: Operation,
    spec: SyntheticBodySpec,
    values: Record<string, unknown>,
    groups: GroupEmitter,
    module: string,
    byWire: Map<string, SnippetArg>,
  ): Node {
    this.use(module, spec.name);
    const bodyModel = op.requestBody?.kind === 'model' ? this.state.models.get(op.requestBody.name) : undefined;
    const fields: { name: string; value: Node }[] = [];
    for (const f of spec.flatFields) {
      const type = bodyModel?.fields.find((m) => m.name === f.wireName)?.type;
      const v = values[f.wireName];
      let node: Node;
      if (!type) node = f.required ? this.placeholder(f.rustType, 'field') : expr('None');
      else if (v !== undefined) node = this.typed(v, type, f.rustType, 'field');
      else if (!f.required) node = expr('None');
      else node = this.typed(this.examples.forType(type), type, f.rustType, 'field');
      fields.push({ name: f.rustName, value: node });
    }
    for (const g of spec.flattenEnums) {
      const group = (op.parameterGroups ?? []).find((pg) => g.rustName === fieldName(pg.name));
      let node: Node = expr('None');
      if (group && g.required) {
        node = this.groupVariant(group, unwrapOption(g.rustType), groups, module, byWire) ?? expr('None');
      }
      fields.push({ name: g.rustName, value: node });
    }
    return struct(spec.name, fields);
  }

  /** The first variant of a parameter group's enum, with every member set. */
  private groupVariant(
    group: ParameterGroup,
    enumName: string,
    groups: GroupEmitter,
    module: string,
    byWire: Map<string, SnippetArg>,
  ): Node | null {
    const spec = groups.enumSpec(enumName);
    const variant = group.variants[0];
    const variantSpec = spec?.variants[0];
    if (!spec || !variant || !variantSpec) return null;
    this.use(module, spec.name);
    const ref = `${spec.name}::${variantSpec.name}`;
    if (variantSpec.fields.length === 0) return expr(ref);
    const fields = variantSpec.fields.map((f) => {
      const param = variant.parameters.find((p) => p.name === f.wireName);
      if (f.optional || !param) return { name: f.rustName, value: expr('None') };
      const arg = byWire.get(`query:${f.wireName}`) ?? byWire.get(`body:${f.wireName}`);
      const value = arg ? arg.value : this.examples.forParameter(param);
      return { name: f.rustName, value: this.typed(value, param.type, f.rustType, 'field') };
    });
    return struct(ref, fields);
  }

  /**
   * Render `value` as an expression of the SDK's Rust type `rust` (which
   * `type` maps to). `target` is `ctor` for `new(…)` arguments, whose string
   * parameters take `impl Into<String>`.
   */
  typed(value: unknown, type: TypeRef, rust: string, target: 'field' | 'ctor'): Node {
    if (rust.startsWith('Option<')) {
      if (value === null || value === undefined) return expr('None');
      const inner = type.kind === 'nullable' ? type.inner : type;
      return call('Some', [this.typed(value, inner, unwrapOption(rust), 'field')]);
    }
    if (type.kind === 'nullable') return this.typed(value, type.inner, rust, target);
    if (value === null || value === undefined) return this.placeholder(rust, target);
    if (rust === 'String' || rust === 'crate::SecretString') {
      const s = str(typeof value === 'string' ? value : JSON.stringify(value));
      if (target === 'ctor') return s;
      return rust === 'String' ? method(s, 'to_string') : method(s, 'into');
    }
    switch (type.kind) {
      case 'primitive':
      case 'literal':
        return this.scalar(value, rust);
      case 'enum':
        return this.enumValue(value, type.name);
      case 'model':
        return this.model(value, type.name);
      case 'array': {
        const items = Array.isArray(value) ? value : [value];
        const itemRust = rust.startsWith('Vec<') ? rust.slice('Vec<'.length, -1) : 'serde_json::Value';
        if (itemRust === 'u8') return method(str(String(value)), 'as_bytes().to_vec');
        return macro(
          'vec',
          items.map((v) => this.typed(v, type.items, itemRust, 'field')),
        );
      }
      case 'map': {
        const entries = isPlainObject(value) ? Object.entries(value) : [];
        const valueRust = mapValueType(rust);
        if (entries.length === 0) return expr('std::collections::HashMap::new()');
        return call('std::collections::HashMap::from', [
          array(
            entries.map(([k, v]) =>
              tuple([method(str(k), 'to_string'), this.typed(v, type.valueType, valueRust, 'field')]),
            ),
          ),
        ]);
      }
      case 'union':
        return this.union(value, type, rust);
    }
  }

  private scalar(value: unknown, rust: string): Node {
    switch (rust) {
      case 'i64':
      case 'i32':
        return expr(String(Math.trunc(Number(value)) || 0));
      case 'f64':
      case 'f32': {
        const n = Number(value) || 0;
        return expr(Number.isInteger(n) ? `${n}.0` : String(n));
      }
      case 'bool':
        return expr(value === true || value === 'true' ? 'true' : 'false');
      case 'Vec<u8>':
        return method(str(String(value)), 'as_bytes().to_vec');
      default:
        return json(value);
    }
  }

  private enumValue(value: unknown, enumName: string): Node {
    const name = typeName(enumName);
    this.use('', name);
    const values = this.state.enums.get(enumName)?.values ?? [];
    const match = values.find((v) => String(v.value) === String(value)) ?? values[0];
    return expr(`${name}::${variantName(match ? match.value : String(value))}`);
  }

  /** Models have no constructor or `Default`: name every field. */
  private model(value: unknown, modelName: string): Node {
    const model = this.state.models.get(modelName);
    const name = typeName(modelName);
    if (!model) return json(value);
    this.use('', name);
    const values = isPlainObject(value) ? value : {};
    const names = resolveFieldNames(model.fields);
    const fields = model.fields.map((field, i) => {
      // Same field type as the SDK's model emitter (`renderField`).
      let rust = mapTypeRef(field.type, { hint: `${name}${typeName(field.name)}`, registry: this.state.registry });
      if (!field.required || field.type.kind === 'nullable') rust = makeOptional(rust);
      rust = applySecretRedaction(rust, field.name, field, model.fields);
      const v = values[field.name];
      let node: Node;
      if (v !== undefined) node = this.typed(v, field.type, rust, 'field');
      else if (rust.startsWith('Option<')) node = expr('None');
      else node = this.typed(this.examples.forType(field.type), field.type, rust, 'field');
      return { name: names[i]!, value: node };
    });
    return struct(name, fields);
  }

  /** An SDK-synthesized union: wrap the value in the arm whose IR variant fits it. */
  private union(value: unknown, type: Extract<TypeRef, { kind: 'union' }>, rust: string): Node {
    const arms = this.state.registry.armsOf(rust);
    if (!arms) {
      // The union collapsed onto one Rust type (or degraded to `Value`).
      const only = type.variants.find((v) => mapTypeRef(v) === rust);
      return only ? this.typed(value, only, rust, 'field') : json(value);
    }
    this.use('', rust);
    const index = unionVariantIndex(value, type);
    const at = index < 0 ? 0 : index;
    const arm = arms[at];
    const variant = type.variants[at];
    if (!arm || !variant) return json(value);
    return call(`${rust}::${arm.name}`, [this.typed(value, variant, arm.type, 'field')]);
  }

  /** A placeholder for a required value the example data has no value for. */
  private placeholder(rust: string, target: 'field' | 'ctor'): Node {
    if (rust === 'String' || rust === 'crate::SecretString')
      return target === 'ctor' ? str('') : expr('Default::default()');
    return expr('Default::default()');
  }

  private use(module: string, name: string): void {
    const set = this.imports.get(module) ?? new Set<string>();
    set.add(name);
    this.imports.set(module, set);
  }

  program(resolved: ResolvedOperation, c: Call): string {
    const lines: string[] = ['use workos::Client;'];
    for (const [module, names] of [...this.imports].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = [...names].sort();
      const path = module ? `workos::${module}` : 'workos';
      lines.push(sorted.length === 1 ? `use ${path}::${sorted[0]};` : `use ${path}::{${sorted.join(', ')}};`);
    }
    lines.push('');
    lines.push('#[tokio::main]');
    lines.push('async fn main() -> Result<(), workos::Error> {');
    if (c.needsClientId) {
      lines.push(`${INDENT}let client = Client::builder()`);
      lines.push(`${INDENT}${INDENT}.api_key("sk_example_123456789")`);
      lines.push(`${INDENT}${INDENT}.client_id("client_123456789")`);
      lines.push(`${INDENT}${INDENT}.build();`);
    } else {
      lines.push(`${INDENT}let client = Client::new("sk_example_123456789");`);
    }
    lines.push('');
    const binding = isEmptyResponse(resolved.operation) ? '' : 'let _result = ';
    const accessor = resourceAccessorName(resolved.mountOn);
    const head = `${INDENT}${binding}client.${accessor}().${c.method}`;
    const inline = `${head}(${c.args.map(formatInline).join(', ')}).await?;`;
    if (inline.length <= MAX_WIDTH && !inline.includes('\n')) {
      lines.push(inline);
    } else {
      lines.push(`${INDENT}${binding}client`);
      lines.push(`${INDENT}${INDENT}.${accessor}()`);
      const chain = `${INDENT}${INDENT}.${c.method}`;
      lines.push(`${chain}${formatArgs(c.args, `${INDENT}${INDENT}`, chain.length)}`);
      lines.push(`${INDENT}${INDENT}.await?;`);
    }
    lines.push('');
    lines.push(`${INDENT}Ok(())`);
    lines.push('}');
    return lines.join('\n');
  }
}

/** Whether a JSON example value can populate the IR variant `ref`. */
/**
 * The union variant `value` belongs to: the model its discriminator names,
 * else the first variant whose shape fits it.
 */
function unionVariantIndex(value: unknown, type: Extract<TypeRef, { kind: 'union' }>): number {
  const disc = type.discriminator;
  if (disc && isPlainObject(value)) {
    const tag = value[disc.property];
    const target = typeof tag === 'string' ? disc.mapping[tag] : undefined;
    const index = type.variants.findIndex((v) => v.kind === 'model' && v.name === target);
    if (index >= 0) return index;
  }
  return type.variants.findIndex((v) => fits(value, v));
}

function fits(value: unknown, ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'nullable':
      return value === null || fits(value, ref.inner);
    case 'model':
    case 'map':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'enum':
      return typeof value === 'string' || typeof value === 'number';
    case 'literal':
      return value === ref.value;
    case 'primitive':
      if (ref.type === 'string') return typeof value === 'string';
      if (ref.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (ref.type === 'number') return typeof value === 'number';
      if (ref.type === 'boolean') return typeof value === 'boolean';
      return true;
    case 'union':
      return ref.variants.some((v) => fits(value, v));
  }
}

function unwrapOption(rust: string): string {
  return rust.startsWith('Option<') && rust.endsWith('>') ? rust.slice('Option<'.length, -1) : rust;
}

/** The value type of `std::collections::HashMap<String, V>`. */
function mapValueType(rust: string): string {
  const prefix = 'std::collections::HashMap<String, ';
  return rust.startsWith(prefix) ? rust.slice(prefix.length, -1) : 'serde_json::Value';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rustString(s: string): string {
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

// ---------------------------------------------------------------------------
// Layout (rustfmt style)
// ---------------------------------------------------------------------------

type Node =
  | { kind: 'expr'; text: string }
  | { kind: 'call'; fn: string; args: Node[]; open: string; close: string }
  | { kind: 'struct'; name: string; fields: { name: string; value: Node }[]; base?: Node }
  | { kind: 'method'; receiver: Node; name: string };

function expr(text: string): Node {
  return { kind: 'expr', text };
}

function str(s: string): Node {
  return expr(rustString(s));
}

function json(value: unknown): Node {
  return expr(`serde_json::json!(${JSON.stringify(value ?? null)})`);
}

function call(fn: string, args: Node[]): Node {
  return { kind: 'call', fn, args, open: '(', close: ')' };
}

function macro(name: string, args: Node[]): Node {
  return { kind: 'call', fn: `${name}!`, args, open: '[', close: ']' };
}

function array(items: Node[]): Node {
  return { kind: 'call', fn: '', args: items, open: '[', close: ']' };
}

function tuple(items: Node[]): Node {
  return { kind: 'call', fn: '', args: items, open: '(', close: ')' };
}

function method(receiver: Node, name: string): Node {
  return { kind: 'method', receiver, name };
}

function struct(name: string, fields: { name: string; value: Node }[], base?: Node): Node {
  return { kind: 'struct', name, fields, base };
}

function formatInline(node: Node): string {
  switch (node.kind) {
    case 'expr':
      return node.text;
    case 'call':
      return `${node.fn}${node.open}${node.args.map(formatInline).join(', ')}${node.close}`;
    case 'method':
      return `${formatInline(node.receiver)}.${node.name}()`;
    case 'struct': {
      const parts = node.fields.map((f) => `${f.name}: ${formatInline(f.value)}`);
      if (node.base) parts.push(`..${formatInline(node.base)}`);
      return parts.length === 0 ? `${node.name} {}` : `${node.name} { ${parts.join(', ')} }`;
    }
  }
}

/**
 * Render a node whose first line starts at column `column` of a line indented
 * by `indent`. Short calls stay on one line; struct literals with fields and
 * long calls take one entry per line, like rustfmt.
 */
function format(node: Node, indent: string, column: number): string {
  const inline = formatInline(node);
  switch (node.kind) {
    case 'expr':
      return inline;
    case 'method':
      return `${format(node.receiver, indent, column)}.${node.name}()`;
    case 'struct': {
      if (node.fields.length === 0 && !node.base) return inline;
      const inner = indent + INDENT;
      const lines = node.fields.map((f) => {
        const prefix = `${inner}${f.name}: `;
        return `${prefix}${format(f.value, inner, prefix.length)},`;
      });
      if (node.base) {
        const prefix = `${inner}..`;
        lines.push(`${prefix}${format(node.base, inner, prefix.length)}`);
      }
      return `${node.name} {\n${lines.join('\n')}\n${indent}}`;
    }
    case 'call':
      return `${node.fn}${formatArgs(node.args, indent, column + node.fn.length, node.open, node.close)}`;
  }
}

/** `(a, b)` when it fits, else one argument per line with a trailing comma. */
function formatArgs(args: Node[], indent: string, column: number, open = '(', close = ')'): string {
  const inlineArgs = args.map(formatInline).join(', ');
  const fitsInline =
    !inlineArgs.includes('\n') &&
    args.every((a) => a.kind !== 'struct' || (a.fields.length === 0 && !a.base)) &&
    inlineArgs.length <= CALL_WIDTH &&
    column + inlineArgs.length + 2 <= MAX_WIDTH;
  if (fitsInline || args.length === 0) return `${open}${inlineArgs}${close}`;
  // A lone struct literal (or a call wrapping one) hugs the parentheses,
  // like rustfmt's last-argument overflow.
  if (args.length === 1 && hugs(args[0]!)) {
    return `${open}${format(args[0]!, indent, column + 1)}${close}`;
  }
  const inner = indent + INDENT;
  const lines = args.map((a) => `${inner}${format(a, inner, inner.length)},`);
  return `${open}\n${lines.join('\n')}\n${indent}${close}`;
}

/** Whether a lone argument overflows onto the call's own lines. */
function hugs(node: Node): boolean {
  if (node.kind === 'struct') return node.fields.length > 0 || node.base !== undefined;
  if (node.kind === 'call') return node.open === '(' && node.fn !== '' && node.args.length === 1 && hugs(node.args[0]!);
  return false;
}

import type {
  EmitterContext,
  ExampleBuilder,
  Model,
  Operation,
  ParameterGroup,
  ResolvedOperation,
  ResolvedWrapper,
  Service,
  SnippetArg,
  SnippetEmitter,
  TypeRef,
} from '@workos/oagen';
import { collectSnippetArgs, collectWrapperArgs } from '@workos/oagen';
import { enumCanonicalMap, enumMemberNames, primeEnumCanonicalMap } from '../kotlin/enums.js';
import { computeModelAliases, constructorFieldOrder, promoteFieldType } from '../kotlin/models.js';
import {
  className,
  domainPropertyName,
  packageSegment,
  primeReservedTypeNames,
  propertyName,
  resolveMethodName,
  servicePropertyName,
} from '../kotlin/naming.js';
import {
  orderedVariantParameters,
  planKotlinMethod,
  sealedGroupName,
  sortPathParamsByTemplateOrder,
  type KotlinMethodParam,
} from '../kotlin/resources.js';
import { mapTypeRef } from '../kotlin/type-map.js';
import { resolveKotlinWrapperParams } from '../kotlin/wrappers.js';
import { isHandwrittenOverride } from '../kotlin/overrides.js';
import { collectBodyFieldTypes } from '../shared/resolved-ops.js';

const INDENT = '    ';
const MAX_INLINE = 80;

/**
 * Java call-site snippets for the generated workos-kotlin SDK (rendered as
 * `.java`; Java is the most common JVM consumer).
 *
 * Every name, parameter order and type comes from the Kotlin SDK emitter
 * (`src/kotlin/`), so a snippet compiles against the SDK generated from the
 * same spec. Java has no named or default arguments: calls pass the method's
 * parameters positionally, fill skipped optional slots with `null` (or
 * `PatchField.absent()` for PATCH bodies), and rely on `@JvmOverloads` to drop
 * the trailing ones. Service accessors are Kotlin properties, read through
 * their `getX()` getters; models are built with their data-class constructors.
 *
 * Pass the shipped SDK's API surface (`oagen extract --lang kotlin`) as
 * `ctx.apiSurface`: the SDK pins each method's parameter order to its last
 * release, and without the surface the emitter can only assume the schema
 * order.
 */
export const kotlinSnippetEmitter: SnippetEmitter = {
  language: 'java',
  fileExtension: 'java',

  renderOperation(resolved, ctx, examples) {
    if (resolved.urlBuilder || isHandwrittenOverride(resolved.operation)) return null;
    // Type and enum names resolve the same way the SDK emitter resolves them;
    // Java cannot see the `typealias` files aliased enums become.
    primeReservedTypeNames(ctx.spec);
    primeEnumCanonicalMap(ctx.spec.enums);
    const r = new Renderer(ctx, examples, modelAliases(ctx));
    const call =
      resolved.wrappers && resolved.wrappers.length > 0
        ? r.wrapperCall(resolved, resolved.wrappers[0]!)
        : r.operationCall(resolved);
    return r.program(call);
  },
};

interface Call {
  accessor: string;
  method: string;
  args: Node[];
  needsClientId: boolean;
}

interface Slot {
  optional: boolean;
  /** The value Java passes for a skipped optional slot. */
  filler: string;
  value: Node | null;
}

class Renderer {
  private readonly imports = new Set<string>(['com.workos.WorkOS']);

  constructor(
    private readonly ctx: EmitterContext,
    private readonly examples: ExampleBuilder,
    private readonly aliasOf: Map<string, string>,
  ) {}

  operationCall(resolved: ResolvedOperation): Call {
    const op = resolved.operation;
    const mountName = resolved.mountOn;
    const method = resolveMethodName(op, findService(this.ctx, op) ?? ({} as Service), this.ctx);
    // The SDK keeps the positional slots of its last release (the api-surface
    // baseline), so a positional Java call is only right against that order.
    // Use the surface when it describes the Kotlin SDK; ignore any other
    // language's surface.
    const sdkCtx = this.ctx.apiSurface?.language === 'kotlin' ? this.ctx : { ...this.ctx, apiSurface: undefined };
    const signature = planKotlinMethod(mountName, method, op, sdkCtx, resolved);
    const { args } = collectSnippetArgs(resolved, this.ctx, this.examples);
    const byWire = new Map<string, SnippetArg>();
    for (const a of args) byWire.set(`${a.source}:${a.wireName}`, a);

    const slots = signature.params.map((p) => this.slot(p, op, mountName, byWire));
    // A required parameter after `requestOptions` was added as required on
    // top of the surface's own baseline, and the release that added it has no
    // `@JvmOverloads` (the surface does not record annotations). Passing every
    // slot compiles with or without the overloads.
    const requestOptionsAt = signature.params.findIndex((p) => p.source.kind === 'requestOptions');
    const appendedRequired = signature.params.slice(requestOptionsAt + 1).some((p) => !p.optional);
    return {
      accessor: accessorGetter(mountName),
      method,
      args: trimSlots(slots, signature.jvmOverloads && !appendedRequired),
      needsClientId: (resolved.inferFromClient ?? []).includes('client_id'),
    };
  }

  wrapperCall(resolved: ResolvedOperation, wrapper: ResolvedWrapper): Call {
    const op = resolved.operation;
    const args = collectWrapperArgs(wrapper, this.ctx, this.examples);
    const byWire = new Map(args.map((a) => [a.wireName, a]));
    const slots: Slot[] = [];
    // Wrapper methods take path params in template order, then the wrapper's
    // params with required ones first (see resolveKotlinWrapperParams).
    for (const p of sortPathParamsByTemplateOrder(op)) {
      slots.push({ optional: false, filler: 'null', value: str(String(this.examples.forParameter(p))) });
    }
    for (const rp of resolveKotlinWrapperParams(wrapper, this.ctx)) {
      const arg = byWire.get(rp.paramName);
      const type = rp.field?.type;
      let value: Node | null = null;
      if (arg) value = type ? this.typed(arg.value, type) : str(String(arg.value));
      else if (!rp.isOptional) value = type ? this.typed(this.examples.forType(type), type) : str('');
      slots.push({ optional: rp.isOptional, filler: 'null', value });
    }
    slots.push({ optional: true, filler: 'null', value: null });
    const inferred = [...(wrapper.inferFromClient ?? []), ...(resolved.inferFromClient ?? [])];
    return {
      accessor: accessorGetter(resolved.mountOn),
      method: propertyName(wrapper.name),
      // Wrapper methods always carry @JvmOverloads.
      args: trimSlots(slots, true),
      needsClientId: inferred.includes('client_id'),
    };
  }

  private slot(param: KotlinMethodParam, op: Operation, mountName: string, byWire: Map<string, SnippetArg>): Slot {
    const source = param.source;
    switch (source.kind) {
      case 'path': {
        const arg = byWire.get(`path:${source.param.name}`);
        // Path params are always `String` in the SDK.
        const value = arg ? arg.value : this.examples.forParameter(source.param);
        return { optional: false, filler: 'null', value: str(String(value)) };
      }
      case 'query': {
        const arg = byWire.get(`query:${source.param.name}`);
        const kotlinType = declType(param.decl);
        let value: Node | null = null;
        if (arg) value = this.typed(arg.value, source.param.type, kotlinType);
        else if (!param.optional) {
          value = this.typed(this.examples.forParameter(source.param), source.param.type, kotlinType);
        }
        return { optional: param.optional, filler: 'null', value };
      }
      case 'body': {
        const arg = byWire.get(`body:${source.field.name}`);
        let value: Node | null = null;
        if (arg) value = this.typed(arg.value, source.field.type);
        else if (!param.optional) value = this.typed(this.examples.forType(source.field.type), source.field.type);
        if (source.patch) {
          this.imports.add('com.workos.common.http.PatchField');
          return {
            optional: true,
            filler: 'PatchField.absent()',
            value: value ? call('PatchField.of', [value]) : null,
          };
        }
        return { optional: param.optional, filler: 'null', value };
      }
      case 'group': {
        // A required group takes one of its sealed variants; show the first.
        const value = param.optional ? null : this.groupVariant(op, mountName, source.group);
        return { optional: param.optional, filler: 'null', value };
      }
      case 'requestOptions':
        return { optional: true, filler: 'null', value: null };
    }
  }

  private groupVariant(op: Operation, mountName: string, group: ParameterGroup): Node | null {
    const variant = group.variants[0];
    if (!variant) return null;
    const sealed = sealedGroupName(group);
    this.imports.add(`com.workos.${packageSegment(mountName)}.${sealed}`);
    const bodyFieldTypes = collectBodyFieldTypes(op, this.ctx.spec.models);
    const { parameters, optionalNames } = orderedVariantParameters(variant);
    // Variant data classes have no @JvmOverloads: Java passes every member.
    const members = parameters.map((p) => {
      if (optionalNames.has(p.name)) return expr('null');
      const type = bodyFieldTypes.get(p.name) ?? p.type;
      return this.typed(this.examples.forParameter(p), type);
    });
    return newObject(`${sealed}.${className(variant.name)}`, members);
  }

  /**
   * Render `value` as a Java expression for a parameter or field the SDK types
   * from `type`. `kotlinType` overrides the declared Kotlin type where the SDK
   * narrows it (list `limit` params are `Int`).
   */
  typed(value: unknown, type: TypeRef, kotlinType?: string): Node {
    if (value === null || value === undefined) return expr('null');
    if (type.kind === 'nullable') return this.typed(value, type.inner, kotlinType);
    const kt = (kotlinType ?? mapTypeRef(type)).replace(/\?$/, '');
    switch (type.kind) {
      case 'primitive':
        return this.scalar(value, kt);
      case 'literal':
        return this.scalar(type.value ?? value, kt);
      case 'enum':
        return this.enumValue(value, type.name);
      case 'model':
        return this.model(value, type.name);
      case 'array': {
        if (!Array.isArray(value)) return this.untyped(value);
        this.imports.add('java.util.List');
        return call(
          'List.of',
          value.map((v) => this.typed(v, type.items)),
        );
      }
      case 'map': {
        if (!isPlainObject(value)) return this.untyped(value);
        return this.mapOf(Object.entries(value).map(([k, v]) => [k, this.typed(v, type.valueType)]));
      }
      case 'union': {
        // Render through the variant the SDK picked for this union's type.
        for (const variant of type.variants) {
          if (variant.kind === 'literal' && variant.value === null) continue;
          if (mapTypeRef(variant).replace(/\?$/, '') === kt) return this.typed(value, variant);
        }
        return this.untyped(value);
      }
      default:
        return this.untyped(value);
    }
  }

  private scalar(value: unknown, kt: string): Node {
    switch (kt) {
      case 'String':
        return str(typeof value === 'string' ? value : JSON.stringify(value));
      case 'Int':
        return expr(String(toInt(value)));
      case 'Long':
        return expr(`${toInt(value)}L`);
      case 'Double': {
        const n = typeof value === 'number' ? value : Number.parseFloat(String(value)) || 0;
        return expr(Number.isInteger(n) ? `${n}.0` : String(n));
      }
      case 'Boolean':
        return expr(value === true || value === 'true' ? 'true' : 'false');
      case 'OffsetDateTime':
        this.imports.add('java.time.OffsetDateTime');
        return call('OffsetDateTime.parse', [str(String(value))]);
      case 'ByteArray':
        return expr(`${javaString(String(value))}.getBytes()`);
      default:
        return this.untyped(value);
    }
  }

  private enumValue(value: unknown, enumName: string): Node {
    const canonicalName = enumCanonicalMap.get(enumName) ?? enumName;
    const enumDef =
      this.ctx.spec.enums.find((e) => e.name === canonicalName) ?? this.ctx.spec.enums.find((e) => e.name === enumName);
    const typeName = mapTypeRef({ kind: 'enum', name: enumName });
    this.imports.add(`com.workos.types.${typeName}`);
    const wire = String(value);
    const member = enumDef ? enumMemberNames(enumDef, typeName).get(wire) : undefined;
    return expr(`${typeName}.${member ?? 'Unknown'}`);
  }

  private model(value: unknown, modelName: string): Node {
    // Structurally identical models are typealiases of one class in the SDK;
    // Java can only name that class.
    const canonical = this.aliasOf.get(modelName) ?? modelName;
    const model = findModel(this.ctx, canonical);
    if (!model || model.fields.length === 0 || !isPlainObject(value)) return this.untyped(value);
    const typeName = className(canonical);
    this.imports.add(`com.workos.models.${typeName}`);
    // Data-class constructors have no @JvmOverloads: Java passes every
    // parameter, in constructor order, with null for absent optional fields.
    const seen = new Set<string>();
    const args: Node[] = [];
    for (const raw of constructorFieldOrder(model)) {
      const field = promoteFieldType(raw);
      const prop = domainPropertyName(field);
      if (seen.has(prop)) continue;
      seen.add(prop);
      const v = value[field.name];
      if (v !== undefined) args.push(this.typed(v, field.type));
      else if (field.type.kind === 'literal' && field.type.value !== null)
        args.push(this.typed(field.type.value, field.type));
      else if (!field.required) args.push(expr('null'));
      else args.push(this.typed(this.examples.forType(field.type), field.type));
    }
    return newObject(typeName, args);
  }

  /** Values typed `Any` in the SDK: Java boxes literals, so render them plainly. */
  private untyped(value: unknown): Node {
    if (value === null || value === undefined) return expr('null');
    if (typeof value === 'boolean') return expr(value ? 'true' : 'false');
    if (typeof value === 'number') return expr(String(value));
    if (typeof value === 'string') return str(value);
    if (Array.isArray(value)) {
      this.imports.add('java.util.List');
      return call(
        'List.of',
        value.map((v) => this.untyped(v)),
      );
    }
    if (isPlainObject(value)) return this.mapOf(Object.entries(value).map(([k, v]) => [k, this.untyped(v)]));
    return expr('null');
  }

  private mapOf(entries: [string, Node][]): Node {
    this.imports.add('java.util.Map');
    return call(
      'Map.of',
      entries.flatMap(([k, v]) => [str(k), v]),
    );
  }

  program(c: Call): string {
    const lines: string[] = [];
    for (const imp of [...this.imports].sort()) lines.push(`import ${imp};`);
    lines.push('');
    if (c.needsClientId) {
      lines.push('WorkOS workos = WorkOS.builder()');
      lines.push(`${INDENT}.apiKey("sk_example_123456789")`);
      lines.push(`${INDENT}.clientId("client_123456789")`);
      lines.push(`${INDENT}.build();`);
    } else {
      lines.push('WorkOS workos = new WorkOS("sk_example_123456789");');
    }
    lines.push('');
    lines.push(`${format(call(`workos.${c.accessor}.${c.method}`, c.args), '')};`);
    return lines.join('\n');
  }
}

const aliasCache = new WeakMap<object, Map<string, string>>();

function modelAliases(ctx: EmitterContext): Map<string, string> {
  let aliases = aliasCache.get(ctx.spec);
  if (!aliases) {
    aliases = computeModelAliases(ctx.spec.models, ctx).aliasOf;
    aliasCache.set(ctx.spec, aliases);
  }
  return aliases;
}

/**
 * Drop trailing skipped optional slots (the `@JvmOverloads` overloads omit
 * them) and fill the remaining skipped slots. Without `@JvmOverloads` Java
 * passes every parameter.
 */
function trimSlots(slots: Slot[], jvmOverloads: boolean): Node[] {
  let end = slots.length;
  if (jvmOverloads) {
    while (end > 0 && slots[end - 1]!.optional && slots[end - 1]!.value === null) end -= 1;
  }
  return slots.slice(0, end).map((s) => s.value ?? expr(s.filler));
}

/** Java getter for the Kotlin service property, e.g. `getOrganizations()`. */
function accessorGetter(mountName: string): string {
  const prop = servicePropertyName(mountName);
  return `get${prop.charAt(0).toUpperCase()}${prop.slice(1)}()`;
}

/** The Kotlin type of a rendered parameter declaration (`name: Type = default`). */
function declType(decl: string): string {
  const m = /:\s*(.+?)(?:\s*=.*)?$/.exec(decl.trim());
  return m ? m[1]! : 'Any';
}

function toInt(value: unknown): number {
  return typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10) || 0;
}

function findService(ctx: EmitterContext, op: Operation): Service | undefined {
  return ctx.spec.services.find((s) => s.operations.includes(op));
}

function findModel(ctx: EmitterContext, name: string): Model | undefined {
  return ctx.spec.models.find((m) => m.name === name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function javaString(s: string): string {
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type Node = { kind: 'expr'; text: string } | { kind: 'call'; fn: string; args: Node[] };

function expr(text: string): Node {
  return { kind: 'expr', text };
}

function str(s: string): Node {
  return expr(javaString(s));
}

function call(fn: string, args: Node[]): Node {
  return { kind: 'call', fn, args };
}

function newObject(typeName: string, args: Node[]): Node {
  return call(`new ${typeName}`, args);
}

function formatInline(node: Node): string {
  return node.kind === 'expr' ? node.text : `${node.fn}(${node.args.map(formatInline).join(', ')})`;
}

/**
 * Render a node starting on a line indented by `indent`; a call that does not
 * fit takes one argument per line.
 */
function format(node: Node, indent: string): string {
  const inline = formatInline(node);
  if (node.kind === 'expr' || indent.length + inline.length <= MAX_INLINE || node.args.length === 0) return inline;
  const inner = indent + INDENT;
  const args = node.args.map((a, i) => `${inner}${format(a, inner)}${i < node.args.length - 1 ? ',' : ''}`);
  return `${node.fn}(\n${args.join('\n')})`;
}

import type { EmitterContext, Enum, GeneratedFile, Model, TypeRef, UnionType } from '@workos/oagen';
import { className, fieldName } from './naming.js';
import { isModelInScope, isScopedRun } from '../shared/resolved-ops.js';
import { readPriorFile, parseFlatGoBlocks } from './flat-merge.js';

/**
 * Go has no sum types, so a discriminated `oneOf` on a model field is emitted
 * as a *sealed wrapper*: a struct carrying the discriminator value plus one
 * nil-able pointer per variant, with an `UnmarshalJSON` that switches on the
 * discriminator and decodes the payload into the matching field.
 *
 * The alternative — rendering the union as its first variant — silently drops
 * every field that only exists on a later variant, and cannot represent a
 * shared field whose type differs across variants (`value` as
 * `boolean | string | number` keyed on `value_type`). The wrapper keeps each
 * variant in its own typed field, so no variant loses data and no payload is
 * decoded into the wrong Go type.
 *
 * Scope is deliberately **model fields only**. Per-operation error unions
 * (`Error400` and friends) are also discriminated, but the parser names every
 * one of their leading variants after the status code, so dozens of unrelated
 * unions would claim a single wrapper name. Naming those needs operation
 * context the IR doesn't attach to a `TypeRef`; they keep collapsing to their
 * first variant exactly as before.
 *
 * {@link prepareGoUnions} resolves the wrapper set once per run and every other
 * entry point reads that registry, so the type map, the flatten opt-out, and
 * the rendered file can never disagree about which unions have a wrapper.
 */

/** One variant arm of a discriminated union wrapper. */
export interface UnionArm {
  /** Discriminator value on the wire that selects this arm. */
  value: string;
  /** IR model name of the variant payload. */
  modelName: string;
  /** Exported Go field / accessor suffix, derived from the wire value. */
  field: string;
  /** Go type of the variant payload. */
  goType: string;
  /** Name of the generated discriminator constant for this arm. */
  constName: string;
}

/** A discriminated union wrapper to emit. */
export interface GoUnion {
  /** Go type name of the wrapper struct. */
  name: string;
  /** Wire name of the discriminator property. */
  property: string;
  /** Exported Go field name holding the discriminator. */
  discriminatorField: string;
  /** Go named-string type enumerating the discriminator values. */
  discriminatorType: string;
  arms: UnionArm[];
}

/**
 * Wrappers resolved for the current run, keyed by {@link unionSignature}.
 * Reset by {@link prepareGoUnions}; empty until then, so any entry point that
 * runs without it degrades to the pre-wrapper behavior rather than emitting a
 * reference to a type that was never generated. Mirrors the per-run registry
 * the Rust emitter keeps for its synthesised oneOf enums.
 */
let registry = new Map<string, GoUnion>();

/**
 * Whether a union has the shape a wrapper can represent. Necessary but not
 * sufficient — {@link prepareGoUnions} also has to be able to name it
 * unambiguously. Use {@link hasUnionWrapper} to ask whether one was actually
 * generated.
 */
export function isWrappableDiscriminatedUnion(ref: UnionType): boolean {
  // allOf is inheritance, not an exclusive union — it keeps collapsing to its
  // first member.
  if (ref.compositionKind === 'allOf') return false;
  const disc = ref.discriminator;
  if (!disc || Object.keys(disc.mapping).length === 0) return false;
  if (ref.variants.length === 0) return false;
  // Every variant must be a named model: the wrapper gives each arm a typed
  // field, which requires a struct to point at. Untagged primitive unions
  // carry no discriminator and never reach here, but guard anyway.
  return ref.variants.every((v) => v.kind === 'model');
}

/**
 * Name a wrapper would take. Single-variant unions get one too: emitting the
 * wrapper up front makes adding a second variant later a purely additive change
 * to the generated SDK rather than a type replacement.
 */
function baseWrapperName(ref: UnionType): string | null {
  const first = ref.variants.find((v) => v.kind === 'model');
  if (!first || first.kind !== 'model') return null;
  return `${className(first.name)}Union`;
}

/** Go type name of a union's wrapper, or null when this run generated none. */
export function unionWrapperName(ref: UnionType): string | null {
  if (!isWrappableDiscriminatedUnion(ref)) return null;
  return registry.get(unionSignature(ref))?.name ?? null;
}

/** Whether this union is emitted as a wrapper (so the flatten must skip it). */
export function hasUnionWrapper(ref: UnionType): boolean {
  return unionWrapperName(ref) !== null;
}

/** Stable identity of a union: two refs with the same signature share a wrapper. */
function unionSignature(ref: UnionType): string {
  return JSON.stringify({
    property: ref.discriminator?.property ?? null,
    mapping: ref.discriminator?.mapping ?? null,
    variants: ref.variants.map((v) => (v.kind === 'model' ? v.name : v.kind)),
  });
}

/** Visit every union node reachable from a TypeRef. */
function forEachUnion(ref: TypeRef, visit: (union: UnionType) => void): void {
  switch (ref.kind) {
    case 'union':
      visit(ref);
      for (const v of ref.variants) forEachUnion(v, visit);
      break;
    case 'array':
      forEachUnion(ref.items, visit);
      break;
    case 'nullable':
      forEachUnion(ref.inner, visit);
      break;
    case 'map':
      if (ref.keyType) forEachUnion(ref.keyType, visit);
      forEachUnion(ref.valueType, visit);
      break;
    default:
      break;
  }
}

/**
 * Resolve the wrapper set for this run and return it in emit order. Call once,
 * before anything maps a TypeRef, so every consumer sees the same registry.
 *
 * `emittableModel` gates which variant models an arm may point at: in a scoped
 * run a brand-new out-of-scope model is never written to `models.go`, so an arm
 * referencing it would not compile.
 */
export function prepareGoUnions(
  models: Model[],
  enums: Enum[],
  emittableModel: (modelName: string) => boolean,
): GoUnion[] {
  registry = new Map();

  // Candidate unions, deduplicated by signature and in first-seen order.
  const candidates = new Map<string, UnionType>();
  for (const model of models) {
    for (const field of model.fields) {
      forEachUnion(field.type, (union) => {
        if (!isWrappableDiscriminatedUnion(union)) return;
        const signature = unionSignature(union);
        if (!candidates.has(signature)) candidates.set(signature, union);
      });
    }
  }
  if (candidates.size === 0) return [];

  // A wrapper name must be unambiguous. Two structurally different unions whose
  // leading variant shares a name (the `Error400` shape) cannot both own it, and
  // picking a winner would silently give the loser the wrong variants — so
  // neither is wrapped and both keep the first-variant collapse.
  const claimants = new Map<string, number>();
  for (const union of candidates.values()) {
    const base = baseWrapperName(union);
    if (base) claimants.set(base, (claimants.get(base) ?? 0) + 1);
  }

  // The wrapper is a new top-level declaration in the same flat package, so it
  // must not collide with a model or enum that is already declared there.
  const declared = new Set<string>([...models.map((m) => className(m.name)), ...enums.map((e) => className(e.name))]);

  for (const [signature, union] of candidates) {
    const base = baseWrapperName(union);
    if (!base) continue;
    if (claimants.get(base) !== 1) {
      console.warn(
        `[oagen:go] ${claimants.get(base)} distinct discriminated unions would all be named "${base}"; ` +
          'emitting none of them as a wrapper. Disambiguate by renaming the leading variant of each in the spec.',
      );
      continue;
    }
    if (declared.has(base)) {
      console.warn(`[oagen:go] discriminated union wrapper "${base}" collides with an existing type; skipping it.`);
      continue;
    }
    registry.set(signature, buildUnion(base, union, emittableModel));
  }

  return [...registry.values()];
}

function buildUnion(name: string, union: UnionType, emittableModel: (modelName: string) => boolean): GoUnion {
  const disc = union.discriminator!;
  const discriminatorField = fieldName(disc.property);
  const discriminatorType = `${name}${discriminatorField}`;

  // Variant models the union declares, so an explicit `mapping:` entry that
  // points outside the union can't smuggle in an unrelated type.
  const variantNames = new Set(union.variants.flatMap((v) => (v.kind === 'model' ? [v.name] : [])));

  const taken = new Set<string>([discriminatorField]);
  const arms: UnionArm[] = [];
  for (const [value, modelName] of Object.entries(disc.mapping)) {
    if (!variantNames.has(modelName)) continue;
    if (!emittableModel(modelName)) continue;

    let field = className(value);
    if (!field) continue;
    if (taken.has(field)) {
      let n = 2;
      while (taken.has(`${field}${n}`)) n++;
      field = `${field}${n}`;
    }
    taken.add(field);

    arms.push({
      value,
      modelName,
      field,
      goType: className(modelName),
      constName: `${discriminatorType}${field}`,
    });
  }

  return { name, property: disc.property, discriminatorField, discriminatorType, arms };
}

/** Backtick, kept out of the template literals that build struct tags. */
const TICK = '`';

function renderUnion(u: GoUnion): string {
  const l: string[] = [];
  const { name, discriminatorField: df, discriminatorType: dt } = u;

  l.push(`// ${name} is a discriminated union: exactly one variant pointer is set,`);
  l.push(`// and ${df} says which. Use the As* accessors to read a variant safely.`);
  l.push(`type ${name} struct {`);
  l.push(`\t// ${df} identifies which variant this union holds.`);
  l.push(`\t${df} ${dt} ${TICK}json:"${u.property}"${TICK}`);
  for (const arm of u.arms) {
    l.push(`\t// ${arm.field} is set when ${df} is ${arm.constName}.`);
    l.push(`\t${arm.field} *${arm.goType} ${TICK}json:"-"${TICK}`);
  }
  l.push('');
  l.push('\t// raw retains the payload as received so an unrecognized discriminator');
  l.push('\t// value survives an unmarshal/marshal round trip instead of being dropped.');
  l.push('\traw json.RawMessage');
  l.push('}');
  l.push('');

  l.push(`// ${dt} identifies the variant held by ${articleFor(name)} ${name}.`);
  l.push(`type ${dt} string`);
  if (u.arms.length > 0) {
    l.push('');
    l.push('const (');
    for (const arm of u.arms) {
      l.push(`\t// ${arm.constName} selects the ${arm.goType} variant.`);
      l.push(`\t${arm.constName} ${dt} = "${escapeGoString(arm.value)}"`);
    }
    l.push(')');
  }

  for (const arm of u.arms) {
    l.push('');
    l.push(`// As${arm.field} returns the ${arm.goType} variant and reports whether it is set.`);
    l.push(`func (u ${name}) As${arm.field}() (*${arm.goType}, bool) {`);
    l.push(`\treturn u.${arm.field}, u.${arm.field} != nil`);
    l.push('}');
  }

  l.push('');
  l.push(`// UnmarshalJSON decodes the payload into the variant selected by the`);
  l.push(`// "${escapeGoString(u.property)}" discriminator. An unrecognized value leaves every`);
  l.push(`// variant nil; ${df} still reports what the wire said.`);
  l.push(`func (u *${name}) UnmarshalJSON(data []byte) error {`);
  l.push('\tvar discriminator struct {');
  l.push(`\t\tValue ${dt} ${TICK}json:"${u.property}"${TICK}`);
  l.push('\t}');
  l.push('\tif err := json.Unmarshal(data, &discriminator); err != nil {');
  l.push('\t\treturn err');
  l.push('\t}');
  l.push('');
  l.push(`\t*u = ${name}{${df}: discriminator.Value, raw: append(json.RawMessage(nil), data...)}`);
  if (u.arms.length > 0) {
    l.push('');
    l.push(`\tswitch discriminator.Value {`);
    for (const arm of u.arms) {
      l.push(`\tcase ${arm.constName}:`);
      l.push(`\t\tvar v ${arm.goType}`);
      l.push('\t\tif err := json.Unmarshal(data, &v); err != nil {');
      l.push('\t\t\treturn err');
      l.push('\t\t}');
      l.push(`\t\tu.${arm.field} = &v`);
    }
    l.push('\t}');
  }
  l.push('');
  l.push('\treturn nil');
  l.push('}');

  l.push('');
  l.push(`// MarshalJSON encodes the variant selected by ${df}.`);
  l.push(`func (u ${name}) MarshalJSON() ([]byte, error) {`);
  if (u.arms.length > 0) {
    l.push(`\tswitch u.${df} {`);
    for (const arm of u.arms) {
      l.push(`\tcase ${arm.constName}:`);
      l.push(`\t\tif u.${arm.field} != nil {`);
      l.push(`\t\t\treturn json.Marshal(u.${arm.field})`);
      l.push('\t\t}');
    }
    l.push('\t}');
    l.push('');
  }
  l.push('\t// No variant set: replay the original payload when we have one, so a');
  l.push('\t// value produced by UnmarshalJSON always round trips.');
  l.push('\tif len(u.raw) > 0 {');
  l.push('\t\treturn u.raw, nil');
  l.push('\t}');
  l.push(`\tif u.${df} == "" {`);
  l.push('\t\treturn []byte("null"), nil');
  l.push('\t}');
  l.push(`\treturn json.Marshal(map[string]string{"${escapeGoString(u.property)}": string(u.${df})})`);
  l.push('}');

  return l.join('\n');
}

/** "an" before a vowel-initial type name, "a" otherwise. */
function articleFor(name: string): string {
  return /^[AEIOU]/.test(name) ? 'an' : 'a';
}

/** Escape a spec-supplied string for embedding in a Go interpreted string literal. */
function escapeGoString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** True when a model will exist in `models.go` after this run. */
export function emittableModelPredicate(models: Model[], ctx: EmitterContext): (modelName: string) => boolean {
  // Mirror models.ts: in a scoped run only models that are in scope (emitted
  // fresh) or already on disk (left untouched) exist after the run.
  if (!isScopedRun(ctx)) {
    const known = new Set(models.map((m) => m.name));
    return (name) => known.has(name);
  }
  const prior = new Set(parseFlatGoBlocks(readPriorFile('models.go', ctx) ?? '').blocks.flatMap((b) => b.names));
  return (name) => isModelInScope(name, ctx) || prior.has(className(name));
}

/**
 * Render `unions.go` from the wrappers {@link prepareGoUnions} resolved.
 * Returns no file when this run produced none.
 */
export function generateUnions(unions: GoUnion[], ctx: EmitterContext): GeneratedFile[] {
  if (unions.length === 0) return [];

  const lines: string[] = [];
  lines.push(`package ${ctx.namespace}`);
  lines.push('');
  lines.push('import "encoding/json"');
  lines.push('');
  for (const u of unions) {
    lines.push(renderUnion(u));
    lines.push('');
  }

  return [{ path: 'unions.go', content: lines.join('\n'), overwriteExisting: true }];
}

import type {
  Service,
  Operation,
  EmitterContext,
  GeneratedFile,
  Parameter,
  ParameterGroup,
  ResolvedOperation,
  ResolvedWrapper,
  TypeRef,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { fieldName, methodName, typeName, moduleName, variantName } from './naming.js';
import { mapTypeRef, makeOptional, UnionRegistry } from './type-map.js';
import { applySecretRedaction } from './secret.js';
import { parsePathTemplate } from '../shared/path-template.js';
import { groupByMount, buildResolvedLookup } from '../shared/resolved-ops.js';
import { resolveWrapperParams, type ResolvedWrapperParam } from '../shared/wrapper-utils.js';

/**
 * Generate one resource file per mount target under `src/resources/`, plus a
 * `src/resources/mod.rs` barrel. Each file collapses every IR service that
 * mounts on the same target into a single `Api` struct.
 */
export function generateResources(_services: Service[], ctx: EmitterContext, registry: UnionRegistry): GeneratedFile[] {
  const groups = groupByMount(ctx);
  const lookup = buildResolvedLookup(ctx);
  const files: GeneratedFile[] = [];
  const exports: { module: string; struct: string }[] = [];

  for (const [mountName, group] of groups) {
    if (group.operations.length === 0) continue;
    const basename = moduleName(mountName);
    const struct = mountStructName(mountName);
    exports.push({ module: basename, struct });
    files.push({
      path: `src/resources/${basename}.rs`,
      content: renderMountGroup(mountName, group.resolvedOps, ctx, registry, lookup),
      overwriteExisting: true,
    });
  }

  files.push({
    path: 'src/resources/mod.rs',
    content: renderResourcesBarrel(exports),
    overwriteExisting: true,
  });

  return files;
}

/** PascalCase struct name for a mount target (e.g., `UserManagementApi`). */
export function mountStructName(mountName: string): string {
  const base = typeName(mountName);
  return base.endsWith('Api') ? base : `${base}Api`;
}

function renderMountGroup(
  mountName: string,
  resolvedOps: ResolvedOperation[],
  ctx: EmitterContext,
  registry: UnionRegistry,
  _lookup: Map<string, ResolvedOperation>,
): string {
  const struct = mountStructName(mountName);
  const lines: string[] = [];
  lines.push('use crate::client::Client;');
  lines.push('#[allow(unused_imports)]');
  lines.push('use crate::enums::*;');
  lines.push('use crate::error::Error;');
  lines.push('#[allow(unused_imports)]');
  lines.push('use crate::models::*;');
  lines.push('use serde::Serialize;');
  lines.push('');
  lines.push(`pub struct ${struct}<'a> {`);
  lines.push("    pub(crate) client: &'a Client,");
  lines.push('}');
  lines.push('');

  // Parameter-group enums and synthetic body types are emitted once per
  // distinct shape per file (a single mount). Collect them up front so
  // duplicates collapse and per-method emit can reference stable names.
  const groupEmitter = new GroupEmitter();
  const paramsStructs: string[] = [];
  const methods: string[] = [];
  const seenMethods = new Set<string>();

  for (const resolved of resolvedOps) {
    const op = resolved.operation;
    if ((resolved.wrappers?.length ?? 0) > 0) {
      for (const wrapper of resolved.wrappers!) {
        const wrapperMethodName = methodName(wrapper.name);
        if (seenMethods.has(wrapperMethodName)) continue;
        seenMethods.add(wrapperMethodName);
        const paramsType = `${typeName(wrapper.name)}Params`;
        const params = resolveWrapperParams(wrapper, ctx);
        paramsStructs.push(renderWrapperParamsStruct(paramsType, op, wrapper, params, registry, ctx));
        methods.push(renderWrapperMethod(op, wrapper, params, paramsType, wrapperMethodName));
      }
      continue;
    }

    const m = methodName(resolved.methodName);
    if (seenMethods.has(m)) continue;
    seenMethods.add(m);

    // URL-builder ops short-circuit: no params struct (just optional one with
    // the parameters as fields) but no HTTP-issuing methods.
    if (resolved.urlBuilder) {
      const paramsType = `${typeName(resolved.methodName)}Params`;
      const emptyParams = isEmptyParams(op, resolved);
      if (!emptyParams) {
        paramsStructs.push(renderParamsStruct(paramsType, op, resolved, registry, ctx, groupEmitter));
      }
      methods.push(renderUrlBuilderMethod(op, resolved, paramsType, m, emptyParams));
      continue;
    }

    const paramsType = `${typeName(resolved.methodName)}Params`;
    const emptyParams = isEmptyParams(op, resolved);
    if (!emptyParams) {
      paramsStructs.push(renderParamsStruct(paramsType, op, resolved, registry, ctx, groupEmitter));
    }
    methods.push(renderMethod(op, resolved, paramsType, m, emptyParams));

    // Auto-paging variant driven by `op.pagination` IR metadata. URL-builder
    // and HTTP-less ops never qualify.
    const autoPaging = renderAutoPagingMethod(op, resolved, paramsType, m, ctx);
    if (autoPaging) methods.push(autoPaging);
  }

  // Group-related type definitions go between the file header and the params
  // structs so a single file's params can reference them by short name.
  const groupBlock = groupEmitter.render();
  if (groupBlock.length > 0) {
    lines.push(groupBlock);
    lines.push('');
  }

  for (const s of paramsStructs) {
    lines.push(s);
    lines.push('');
  }

  lines.push(`impl<'a> ${struct}<'a> {`);
  methods.forEach((mm, i) => {
    lines.push(mm);
    if (i < methods.length - 1) lines.push('');
  });
  lines.push('}');

  return lines.join('\n').replace(/\n+$/g, '\n');
}

// ─── Parameter-group emitter ────────────────────────────────────────────────
//
// A per-file collector that records each unique enum and synthetic body type
// requested across the file's operations, deduplicates them by structural key,
// and renders them in dependency order. The emitter is otherwise stateless so
// individual `renderParamsStruct` calls just stamp their request and reference
// the resulting Rust names.

interface GroupEnumSpec {
  name: string;
  variants: Array<{
    name: string;
    fields: Array<{ rustName: string; wireName: string; rustType: string }>;
  }>;
}

interface SyntheticBodySpec {
  /** PascalCase type name (e.g. `CheckBody`). */
  name: string;
  /** Body model fields that survive after grouped-field removal. */
  flatFields: Array<{
    rustName: string;
    wireName: string;
    rustType: string;
    required: boolean;
    doc?: string;
  }>;
  /** `#[serde(flatten)]` fields, one per body parameter group. */
  flattenEnums: Array<{
    rustName: string;
    rustType: string;
    required: boolean;
    doc?: string;
  }>;
}

class GroupEmitter {
  private enums: GroupEnumSpec[] = [];
  private bodies: SyntheticBodySpec[] = [];
  private seenEnums = new Set<string>();
  private seenBodies = new Set<string>();

  /** Register a parameter-group enum, returning the PascalCase Rust name. */
  registerEnum(group: ParameterGroup): string {
    const name = typeName(group.name);
    const variants = group.variants.map((v) => ({
      name: typeName(v.name),
      fields: v.parameters.map((p) => ({
        rustName: fieldName(p.name),
        wireName: p.name,
        // Group variant params are always treated as required within their
        // variant — picking the variant is the caller's commitment to supply
        // the variant's full payload.
        rustType: rustTypeForGroupParam(p.type),
      })),
    }));
    if (!this.seenEnums.has(name)) {
      this.seenEnums.add(name);
      this.enums.push({ name, variants });
    }
    return name;
  }

  /** Register a synthetic body struct, returning its PascalCase Rust name. */
  registerBody(spec: SyntheticBodySpec): string {
    if (!this.seenBodies.has(spec.name)) {
      this.seenBodies.add(spec.name);
      this.bodies.push(spec);
    }
    return spec.name;
  }

  render(): string {
    const blocks: string[] = [];
    for (const e of this.enums) {
      const lines: string[] = [];
      lines.push('#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]');
      lines.push('#[serde(untagged)]');
      lines.push(`pub enum ${e.name} {`);
      for (const v of e.variants) {
        if (v.fields.length === 0) {
          lines.push(`    ${v.name},`);
          continue;
        }
        lines.push(`    ${v.name} {`);
        for (const f of v.fields) {
          if (f.rustName !== f.wireName) {
            lines.push(`        #[serde(rename = ${JSON.stringify(f.wireName)})]`);
          }
          lines.push(`        ${f.rustName}: ${f.rustType},`);
        }
        lines.push('    },');
      }
      lines.push('}');
      blocks.push(lines.join('\n'));
    }
    for (const b of this.bodies) {
      const lines: string[] = [];
      // Bodies need `Deserialize` too: the generated test harness builds
      // request stubs via `serde_json::from_str("{}")` and otherwise can't
      // refer to the synthetic type without breaking the fixture pipeline.
      const everythingOptional = b.flatFields.every((f) => !f.required) && b.flattenEnums.every((f) => !f.required);
      const baseDerives = 'Debug, Clone, serde::Serialize, serde::Deserialize';
      const derives = everythingOptional ? `${baseDerives}, Default` : baseDerives;
      lines.push(`#[derive(${derives})]`);
      lines.push(`pub struct ${b.name} {`);
      for (const f of b.flatFields) {
        if (f.doc) {
          for (const c of paramDocComment(f.doc)) lines.push(`    ${c}`);
        }
        if (f.required) {
          if (f.doc) lines.push('    ///');
          lines.push('    /// Required.');
        }
        if (!f.required) {
          lines.push('    #[serde(skip_serializing_if = "Option::is_none")]');
        }
        if (f.rustName !== f.wireName) {
          lines.push(`    #[serde(rename = ${JSON.stringify(f.wireName)})]`);
        }
        lines.push(`    pub ${f.rustName}: ${f.rustType},`);
      }
      for (const f of b.flattenEnums) {
        if (f.doc) {
          for (const c of paramDocComment(f.doc)) lines.push(`    ${c}`);
        }
        lines.push('    #[serde(flatten)]');
        if (!f.required) {
          lines.push('    #[serde(skip_serializing_if = "Option::is_none")]');
        }
        lines.push(`    pub ${f.rustName}: ${f.rustType},`);
      }
      lines.push('}');

      // Constructor for the synthetic body type. Mirrors the params struct's
      // ergonomic: required fields land as positional args, optional ones
      // default via `Default::default`.
      const required = [...b.flatFields.filter((f) => f.required), ...b.flattenEnums.filter((f) => f.required)];
      if (required.length > 0 || b.flatFields.length + b.flattenEnums.length > 0) {
        const ctorArgs = required.map((f) => `${f.rustName}: ${ctorParamType(f.rustType)}`).join(', ');
        const init: string[] = [];
        for (const f of b.flatFields) {
          if (f.required) {
            const value = ctorParamConvert(f.rustType, f.rustName);
            init.push(value === f.rustName ? `            ${f.rustName},` : `            ${f.rustName}: ${value},`);
          } else {
            init.push(`            ${f.rustName}: Default::default(),`);
          }
        }
        for (const f of b.flattenEnums) {
          if (f.required) {
            const value = ctorParamConvert(f.rustType, f.rustName);
            init.push(value === f.rustName ? `            ${f.rustName},` : `            ${f.rustName}: ${value},`);
          } else {
            init.push(`            ${f.rustName}: Default::default(),`);
          }
        }
        lines.push('');
        lines.push(`impl ${b.name} {`);
        lines.push(`    /// Construct a new \`${b.name}\` with the required fields set.`);
        lines.push(`    pub fn new(${ctorArgs}) -> Self {`);
        lines.push('        Self {');
        for (const l of init) lines.push(l);
        lines.push('        }');
        lines.push('    }');
        lines.push('}');
      }
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n');
  }
}

/**
 * Render the Rust type for a parameter-group variant field. Variants commit
 * the caller to supplying their full payload, so optional individual params
 * still flow as `String` (not `Option<String>`); the enum-level choice is the
 * one source of truth for "did the caller pick this variant or not."
 */
function rustTypeForGroupParam(type: TypeRef): string {
  const rust = mapTypeRef(type);
  // Variant fields are non-optional regardless of the IR's per-param flag.
  if (rust.startsWith('Option<')) return rust.slice('Option<'.length, -1);
  return rust;
}

/** Classify each parameter group on an op as "query" or "body". */
function classifyGroup(group: ParameterGroup, op: Operation): 'query' | 'body' {
  const queryNames = new Set(op.queryParams.map((qp) => qp.name));
  const allInQuery = group.variants.every((v) => v.parameters.every((p) => queryNames.has(p.name)));
  return allInQuery ? 'query' : 'body';
}

function renderParamsStruct(
  name: string,
  op: Operation,
  resolved: ResolvedOperation,
  registry: UnionRegistry,
  ctx: EmitterContext,
  groupEmitter: GroupEmitter,
): string {
  const bodyRequired = isBodyRequired(op);
  const hidden = new Set<string>([...Object.keys(resolved.defaults ?? {}), ...(resolved.inferFromClient ?? [])]);
  const materializeSpecDefaults = !resolved.urlBuilder;

  // Names of params that belong to a parameter group; these are folded into
  // the enum field and must be omitted from the flat params struct.
  const queryGroupParamNames = new Set<string>();
  const bodyGroupParamNames = new Set<string>();
  const queryGroupFields: Array<{
    name: string;
    rustType: string;
    required: boolean;
    doc?: string;
  }> = [];
  const bodyGroupFields: Array<{
    name: string;
    rustType: string;
    required: boolean;
    doc?: string;
  }> = [];
  for (const group of op.parameterGroups ?? []) {
    const enumName = groupEmitter.registerEnum(group);
    const rustType = group.optional ? `Option<${enumName}>` : enumName;
    const groupField = {
      name: fieldName(group.name),
      rustType,
      required: !group.optional,
      doc: undefined as string | undefined,
    };
    if (classifyGroup(group, op) === 'query') {
      for (const v of group.variants) for (const p of v.parameters) queryGroupParamNames.add(p.name);
      queryGroupFields.push(groupField);
    } else {
      for (const v of group.variants) for (const p of v.parameters) bodyGroupParamNames.add(p.name);
      bodyGroupFields.push(groupField);
    }
  }

  type FieldInfo = {
    fname: string;
    rust: string;
    required: boolean;
    defaultExpr: string | null;
    doc?: string;
  };
  const fields: FieldInfo[] = [];
  const fieldLines: string[] = [];
  const seen = new Set<string>();
  const emitField = (p: Parameter, opts: { isQuery?: boolean } = {}) => {
    if (hidden.has(p.name)) return;
    if (queryGroupParamNames.has(p.name)) return;
    const fname = fieldName(p.name);
    if (seen.has(fname)) return;
    seen.add(fname);
    let rust = mapTypeRef(p.type, {
      hint: `${name}${typeName(p.name)}`,
      registry,
    });
    if (!p.required && !rust.startsWith('Option<')) rust = makeOptional(rust);
    rust = applySecretRedaction(rust, p.name);
    // Spec-level defaults on HTTP params are materialized so
    // `Default::default()` and `new(…)` produce the documented value. URL
    // builders keep optional query params omitted unless the caller supplies
    // them, because the query string is the public redirect target.
    const defaultExpr =
      materializeSpecDefaults && p.default != null
        ? rustDefaultExpr(p.default, p.type, rust.startsWith('Option<'), ctx)
        : null;
    // Field-level documentation derived from the spec.
    const desc = p.description?.trim();
    if (desc) {
      for (const c of paramDocComment(desc)) fieldLines.push(`    ${c}`);
    }
    if (p.default != null) {
      if (desc) fieldLines.push('    ///');
      fieldLines.push(`    /// Defaults to \`${formatDefault(p.default)}\`.`);
    }
    if (p.required && !rust.startsWith('Option<')) {
      if (desc || p.default != null) fieldLines.push('    ///');
      fieldLines.push('    /// Required.');
    }
    if (rust.startsWith('Option<')) {
      fieldLines.push('    #[serde(skip_serializing_if = "Option::is_none")]');
    }
    // Vec query params with `style: form, explode: false` (the comma-joined
    // wire format) need a custom serializer — serde alone serialises Vec as
    // an array, which our query encoder unrolls into repeated keys.
    if (opts.isQuery && p.explode === false && isVecType(rust)) {
      fieldLines.push(
        rust.startsWith('Option<')
          ? '    #[serde(serialize_with = "crate::query::serialize_comma_separated_opt")]'
          : '    #[serde(serialize_with = "crate::query::serialize_comma_separated")]',
      );
    }
    if (fname !== p.name) {
      fieldLines.push(`    #[serde(rename = ${JSON.stringify(p.name)})]`);
    }
    if (p.deprecated) fieldLines.push('    #[deprecated]');
    fieldLines.push(`    pub ${fname}: ${rust},`);
    fields.push({
      fname,
      rust,
      required: !!p.required && !rust.startsWith('Option<'),
      defaultExpr,
    });
  };

  for (const p of op.queryParams) emitField(p, { isQuery: true });
  for (const p of op.headerParams) emitField(p);
  for (const p of op.cookieParams ?? []) emitField(p);

  // Query-side parameter group fields. Flattened so the encoder sees the
  // variant's own fields at the params struct's top level.
  for (const g of queryGroupFields) {
    fieldLines.push('    #[serde(flatten)]');
    if (!g.required) {
      fieldLines.push('    #[serde(skip_serializing_if = "Option::is_none")]');
    }
    fieldLines.push(`    pub ${g.name}: ${g.rustType},`);
    fields.push({
      fname: g.name,
      rust: g.rustType,
      required: g.required,
      defaultExpr: null,
    });
  }

  if (op.requestBody) {
    let bodyType: string;
    if (bodyGroupFields.length > 0) {
      // Synthesise a body struct that replaces the grouped fields with a
      // flattened enum. The original body model keeps the flat optional
      // fields (it's shared with other consumers); the synthetic type is
      // op-local and serialises with the parameter group's variant in
      // strongly-typed form.
      bodyType = registerSyntheticBody(op, name, bodyGroupParamNames, bodyGroupFields, ctx, registry, groupEmitter);
    } else {
      bodyType = mapTypeRef(op.requestBody, { hint: `${name}Body`, registry });
    }
    if (!bodyRequired && !bodyType.startsWith('Option<')) {
      bodyType = makeOptional(bodyType);
    }
    fieldLines.push('    /// Request body sent with this call.');
    if (bodyRequired) fieldLines.push('    ///');
    if (bodyRequired) fieldLines.push('    /// Required.');
    fieldLines.push('    #[serde(skip)]');
    fieldLines.push(`    pub body: ${bodyType},`);
    fields.push({
      fname: 'body',
      rust: bodyType,
      required: bodyRequired,
      defaultExpr: null,
    });
  }

  // Default-derive only when every field is optional and no field has a
  // spec-level default. Spec defaults need a manual `impl Default` since
  // `Option<T>::default()` is `None`, not `Some(<spec default>)`.
  const requiredFields = fields.filter((f) => f.required);
  const allOptional = fields.length === 0 || requiredFields.length === 0;
  const hasSpecDefault = fields.some((f) => f.defaultExpr !== null);
  const canDeriveDefault = allOptional && !hasSpecDefault;
  const derives = canDeriveDefault ? 'Debug, Clone, Default, Serialize' : 'Debug, Clone, Serialize';

  const out: string[] = [];
  if (fieldLines.length === 0) {
    out.push(`#[derive(${derives})]`, `pub struct ${name} {}`);
  } else {
    out.push(`#[derive(${derives})]`, `pub struct ${name} {`, ...fieldLines, '}');
  }

  // Manual `Default` impl when every field is optional but some have
  // spec-level defaults — `Default::default()` now returns those values
  // instead of `None`.
  if (allOptional && hasSpecDefault) {
    const defaultInitLines = fields.map((f) => `            ${f.fname}: ${f.defaultExpr ?? 'Default::default()'},`);
    out.push('');
    out.push(`impl Default for ${name} {`);
    out.push('    #[allow(deprecated)]');
    out.push('    fn default() -> Self {');
    out.push('        Self {');
    out.push(...defaultInitLines);
    out.push('        }');
    out.push('    }');
    out.push('}');
  }

  // Generate `new(...)` constructor when there is at least one required field
  // but at least one optional field — gives callers a clear ergonomic entry
  // point without forcing them to spell out optional fields.
  if (requiredFields.length > 0) {
    const ctorArgs = requiredFields.map((f) => `${f.fname}: ${ctorParamType(f.rust)}`).join(', ');
    const initLines: string[] = [];
    for (const f of fields) {
      if (f.required) {
        const value = ctorParamConvert(f.rust, f.fname);
        // Use field-init shorthand when the parameter and field names match.
        initLines.push(value === f.fname ? `            ${f.fname},` : `            ${f.fname}: ${value},`);
      } else {
        initLines.push(`            ${f.fname}: ${f.defaultExpr ?? 'Default::default()'},`);
      }
    }
    out.push('');
    out.push(`impl ${name} {`);
    out.push(`    /// Construct a new \`${name}\` with the required fields set.`);
    out.push('    #[allow(deprecated)]');
    out.push(`    pub fn new(${ctorArgs}) -> Self {`);
    out.push('        Self {');
    out.push(...initLines);
    out.push('        }');
    out.push('    }');
    out.push('}');
  }

  return out.join('\n');
}

/** True when a Rust type expression is a `Vec<…>` (or `Option<Vec<…>>`). */
function isVecType(rust: string): boolean {
  const inner = rust.startsWith('Option<') ? rust.slice('Option<'.length, -1) : rust;
  return inner.startsWith('Vec<');
}

/**
 * Build a synthetic body struct for an op that has body-side parameter
 * groups. The original body model can't be reused as-is because its grouped
 * fields are still flat optionals; the synthetic type swaps them for a
 * flattened enum so callers commit to one variant at construction time.
 */
function registerSyntheticBody(
  op: Operation,
  paramsName: string,
  bodyGroupParamNames: Set<string>,
  bodyGroupFields: Array<{
    name: string;
    rustType: string;
    required: boolean;
    doc?: string;
  }>,
  ctx: EmitterContext,
  registry: UnionRegistry,
  groupEmitter: GroupEmitter,
): string {
  // Resolve the original body model (only model-kind bodies can have body
  // groups in the spec; other shapes fall back to the model name directly).
  const bodyRef = op.requestBody;
  if (!bodyRef || bodyRef.kind !== 'model') {
    return mapTypeRef(bodyRef!, { hint: `${paramsName}Body`, registry });
  }
  const model = ctx.spec.models.find((m) => m.name === bodyRef.name);
  if (!model) {
    return typeName(bodyRef.name);
  }
  const name = `${paramsName}Body`;
  const flatFields = model.fields
    .filter((f) => !bodyGroupParamNames.has(f.name))
    .map((f) => {
      let rust = mapTypeRef(f.type, {
        hint: `${name}${typeName(f.name)}`,
        registry,
      });
      if (!f.required && !rust.startsWith('Option<')) rust = makeOptional(rust);
      rust = applySecretRedaction(rust, f.name);
      return {
        rustName: fieldName(f.name),
        wireName: f.name,
        rustType: rust,
        required: !!f.required && !rust.startsWith('Option<'),
        doc: f.description,
      };
    });
  const flattenEnums = bodyGroupFields.map((g) => ({
    rustName: g.name,
    rustType: g.rustType,
    required: g.required,
    doc: g.doc,
  }));
  return groupEmitter.registerBody({ name, flatFields, flattenEnums });
}

/** Constructor parameter type — accept `impl Into<String>` for ergonomic strings. */
function ctorParamType(rust: string): string {
  if (rust === 'String') return 'impl Into<String>';
  if (rust === 'crate::SecretString') return 'impl Into<crate::SecretString>';
  return rust;
}

function ctorParamConvert(rust: string, name: string): string {
  if (rust === 'String') return `${name}.into()`;
  if (rust === 'crate::SecretString') return `${name}.into()`;
  return name;
}

/**
 * Detect a non-default per-operation security requirement (e.g. SSO's
 * `get_profile` requires an OAuth access token rather than the WorkOS API
 * key). Returns the snake_case parameter name to use for the override.
 */
function bearerOverrideToken(op: Operation): string | null {
  const override = op.security?.find((s) => s.schemeName !== 'bearerAuth');
  if (!override) return null;
  return fieldName(override.schemeName);
}

function renderMethod(
  op: Operation,
  resolved: ResolvedOperation,
  paramsType: string,
  method: string,
  emptyParams: boolean,
): string {
  const plan = planOperation(op);
  const segments = parsePathTemplate(op.path);
  const pathArgList = op.pathParams.map((p) => `${methodName(p.name)}: &str`);
  const pathArgNames = op.pathParams.map((p) => methodName(p.name));

  const returnType = renderResponseType(op);
  const bodyRequired = isBodyRequired(op);
  const tokenParam = bearerOverrideToken(op);

  const sig: string[] = [];

  // Convenience method — no per-request options. Delegates to `_with_options`.
  for (const line of methodDocLines(op)) sig.push(`    ${line}`);
  if (op.deprecated) sig.push('    #[deprecated]');
  const argsConvenience = [
    '&self',
    ...pathArgList,
    ...(emptyParams ? [] : [`params: ${paramsType}`]),
    ...(tokenParam ? [`${tokenParam}: impl Into<String>`] : []),
  ];
  const convenienceSig = `    pub async fn ${method}(${argsConvenience.join(', ')}) -> Result<${returnType}, Error> {`;
  if (convenienceSig.length <= 100) {
    sig.push(convenienceSig);
  } else {
    sig.push(`    pub async fn ${method}(`);
    for (const arg of argsConvenience) sig.push(`        ${arg},`);
    sig.push(`    ) -> Result<${returnType}, Error> {`);
  }
  const delegateArgs = [
    ...pathArgNames,
    ...(emptyParams ? [] : ['params']),
    ...(tokenParam ? [tokenParam] : []),
    'None',
  ].join(', ');
  sig.push(`        self.${method}_with_options(${delegateArgs}).await`);
  sig.push('    }');
  sig.push('');

  // `_with_options` variant — per-request idempotency keys, custom headers, etc.
  sig.push(`    /// Variant of [\`Self::${method}\`] that accepts per-request [\`crate::RequestOptions\`].`);
  if (op.deprecated) sig.push('    #[deprecated]');
  const argsOpts = [
    '&self',
    ...pathArgList,
    ...(emptyParams ? [] : [`params: ${paramsType}`]),
    ...(tokenParam ? [`${tokenParam}: impl Into<String>`] : []),
    'options: Option<&crate::RequestOptions>',
  ];
  const optsSig = `    pub async fn ${method}_with_options(${argsOpts.join(', ')}) -> Result<${returnType}, Error> {`;
  if (optsSig.length <= 100) {
    sig.push(optsSig);
  } else {
    sig.push(`    pub async fn ${method}_with_options(`);
    for (const arg of argsOpts) sig.push(`        ${arg},`);
    sig.push(`    ) -> Result<${returnType}, Error> {`);
  }

  const pathFormat = segments
    .map((s) => (s.kind === 'literal' ? s.value : `{${methodName(s.name as string)}}`))
    .join('');
  const pathHasParams = segments.some((s) => s.kind === 'param');

  if (pathHasParams) {
    for (const p of op.pathParams) {
      const n = methodName(p.name);
      sig.push(`        let ${n} = crate::client::path_segment(${n});`);
    }
    sig.push(`        let path = format!(${JSON.stringify(pathFormat)});`);
  } else {
    sig.push(`        let path = ${JSON.stringify(pathFormat)}.to_string();`);
  }

  sig.push(`        let method = http::Method::${op.httpMethod.toUpperCase()};`);

  // Bearer override: build a one-off `RequestOptions` that re-merges any
  // caller-supplied options with the override Authorization header. Done
  // inline so the call site can keep using the standard request helpers.
  if (tokenParam) {
    sig.push(`        let ${tokenParam}: String = ${tokenParam}.into();`);
    sig.push(`        let auth = http::HeaderValue::from_str(&format!("Bearer {${tokenParam}}"))`);
    sig.push(`            .map_err(|e| Error::Builder(format!("invalid bearer token: {e}")))?;`);
    sig.push('        let mut merged = options.cloned().unwrap_or_default();');
    sig.push('        merged.extra_headers.push((http::header::AUTHORIZATION, auth));');
    sig.push('        let options = Some(&merged);');
  }

  // For empty-params endpoints, pass `&()` as the (empty) query — `()`
  // serialises to nothing under serde, matching the previous empty-struct
  // behaviour without surfacing the struct in the public API.
  const queryRef = emptyParams ? '&()' : '&params';
  const emptyResp = isEmptyResponse(op);
  const bodyMethod = emptyResp ? 'request_with_body_opts_empty' : 'request_with_body_opts';
  const queryMethod = emptyResp ? 'request_with_query_opts_empty' : 'request_with_query_opts';

  if (op.requestBody) {
    sig.push('        self.client');
    if (bodyRequired) {
      sig.push(`            .${bodyMethod}(method, &path, ${queryRef}, Some(&params.body), options)`);
    } else {
      sig.push(`            .${bodyMethod}(method, &path, ${queryRef}, params.body.as_ref(), options)`);
    }
    sig.push('            .await');
  } else {
    sig.push('        self.client');
    sig.push(`            .${queryMethod}(method, &path, ${queryRef}, options)`);
    sig.push('            .await');
  }

  sig.push('    }');

  void plan;
  void resolved;
  return sig.join('\n');
}

/**
 * Render a URL-builder method. URL-builder ops (e.g. `GET /sso/authorize`,
 * `GET /sso/logout`) issue no HTTP request — they format a redirect URL the
 * application sends the user to. Generated methods return `Result<String,
 * Error>` because percent-encoding the query string can still fail.
 */
function renderUrlBuilderMethod(
  op: Operation,
  resolved: ResolvedOperation,
  paramsType: string,
  method: string,
  emptyParams: boolean,
): string {
  const segments = parsePathTemplate(op.path);
  const pathArgList = op.pathParams.map((p) => `${methodName(p.name)}: &str`);
  const pathArgNames = op.pathParams.map((p) => methodName(p.name));

  const sig: string[] = [];
  for (const line of methodDocLines(op)) sig.push(`    ${line}`);
  if (op.deprecated) sig.push('    #[deprecated]');
  const args = ['&self', ...pathArgList, ...(emptyParams ? [] : [`params: ${paramsType}`])];
  const headSig = `    pub fn ${method}(${args.join(', ')}) -> Result<String, Error> {`;
  if (headSig.length <= 100) {
    sig.push(headSig);
  } else {
    sig.push(`    pub fn ${method}(`);
    for (const arg of args) sig.push(`        ${arg},`);
    sig.push('    ) -> Result<String, Error> {');
  }

  const pathFormat = segments
    .map((s) => (s.kind === 'literal' ? s.value : `{${methodName(s.name as string)}}`))
    .join('');
  const pathHasParams = segments.some((s) => s.kind === 'param');

  if (pathHasParams) {
    for (const p of op.pathParams) {
      const n = methodName(p.name);
      sig.push(`        let ${n} = crate::client::path_segment(${n});`);
    }
    sig.push(`        let path = format!(${JSON.stringify(pathFormat)});`);
  } else {
    sig.push(`        let path = ${JSON.stringify(pathFormat)}.to_string();`);
  }

  // Bake constant defaults + inferred client fields directly into the query.
  // The runtime helper handles encoding, including arrays and flatten-enum
  // groups, so we just hand it whatever serde produces from `params`.
  const defaults = (resolved.defaults ?? {}) as Record<string, string | number | boolean>;
  const inferred = resolved.inferFromClient ?? [];
  const hasDefaults = Object.keys(defaults).length > 0 || inferred.length > 0;
  if (hasDefaults) {
    sig.push('        let mut overlay = serde_json::Map::new();');
    for (const [k, v] of Object.entries(defaults)) {
      sig.push(`        overlay.insert(${JSON.stringify(k)}.to_string(), serde_json::json!(${JSON.stringify(v)}));`);
    }
    for (const k of inferred) {
      sig.push(
        `        overlay.insert(${JSON.stringify(k)}.to_string(), serde_json::Value::String(${clientFieldExpression(k)}.to_string()));`,
      );
    }
    if (!emptyParams) {
      sig.push('        let params_value = serde_json::to_value(&params)');
      sig.push('            .map_err(|e| Error::Builder(format!("query encode failed: {e}")))?;');
      sig.push('        if let serde_json::Value::Object(map) = params_value {');
      sig.push('            for (k, v) in map { overlay.insert(k, v); }');
      sig.push('        }');
    }
    sig.push('        let merged = serde_json::Value::Object(overlay);');
    sig.push('        let qs = crate::query::encode_query(&merged)?;');
  } else if (!emptyParams) {
    sig.push('        let qs = crate::query::encode_query(&params)?;');
  } else {
    sig.push('        let qs = String::new();');
  }

  sig.push('        let url = if qs.is_empty() {');
  sig.push('            format!("{}{}", self.client.base_url(), path)');
  sig.push('        } else {');
  sig.push('            format!("{}{}?{}", self.client.base_url(), path, qs)');
  sig.push('        };');
  sig.push('        Ok(url)');
  sig.push('    }');

  // Unused path params would otherwise warn; keep them in scope.
  void pathArgNames;
  return sig.join('\n');
}

/**
 * Generate a `<method>_auto_paging` helper from `op.pagination`. Returns null
 * when the operation isn't paginated, when the strategy isn't `cursor`, or
 * when the response model lacks the expected `data` / pagination-cursor
 * fields (defensive — the IR shouldn't produce that combination today).
 */
function renderAutoPagingMethod(
  op: Operation,
  resolved: ResolvedOperation,
  paramsType: string,
  method: string,
  ctx: EmitterContext,
): string | null {
  if (!op.pagination) return null;
  // Only cursor pagination is implemented today; offset / link-header would
  // need a different stream wrapper.
  if (op.pagination.strategy !== 'cursor') return null;
  if (resolved.urlBuilder) return null;
  if (op.response.kind !== 'model') return null;

  const responseModel = ctx.spec.models.find((m) => m.name === (op.response as { name: string }).name);
  if (!responseModel) return null;

  const cursorParam = op.pagination.param;
  const dataPath = op.pagination.dataPath ?? 'data';
  const dataField = responseModel.fields.find((f) => f.name === dataPath);
  if (!dataField || dataField.type.kind !== 'array') return null;
  const listMetadataField = responseModel.fields.find((f) => f.name === 'list_metadata');
  if (!listMetadataField || listMetadataField.type.kind !== 'model') return null;

  // The response cursor lives on the list-metadata model under the same name
  // as the request param. Bail if it doesn't — that would mean a spec/IR
  // mismatch and a hand-written wrapper is safer than a broken generated one.
  const metadataModel = ctx.spec.models.find((m) => m.name === (listMetadataField.type as { name: string }).name);
  if (!metadataModel) return null;
  if (!metadataModel.fields.some((f) => f.name === cursorParam)) return null;

  // The IR's `pagination.itemType` is the response wrapper model (e.g.
  // `OrganizationList`), so reach into the model's `data: Vec<T>` field to
  // pull out the actual element type.
  const itemType = mapTypeRef(dataField.type.items);

  const cursorField = fieldName(cursorParam);
  const dataAccessor = fieldName(dataPath);

  // Path args are taken by owned `String` so the returned stream borrows
  // nothing but `&self`.
  const pathArgList = op.pathParams.map((p) => `${methodName(p.name)}: impl Into<String>`);
  const pathArgNames = op.pathParams.map((p) => methodName(p.name));

  const sig: string[] = [];
  sig.push('');
  sig.push(`    /// Returns an async [\`futures_util::Stream\`] that yields every \`${itemType}\``);
  sig.push(`    /// across all pages, advancing the \`${cursorParam}\` cursor under the hood.`);
  sig.push('    ///');
  sig.push('    /// ```ignore');
  sig.push('    /// use futures_util::TryStreamExt;');
  sig.push(`    /// let all: Vec<${itemType}> = self`);
  sig.push(`    ///     .${method}_auto_paging(${[...pathArgNames, 'params'].join(', ')})`);
  sig.push('    ///     .try_collect()');
  sig.push('    ///     .await?;');
  sig.push('    /// ```');
  if (op.deprecated) sig.push('    #[deprecated]');

  const argsAll = ['&self', ...pathArgList, `params: ${paramsType}`];
  const optsSig = `    pub fn ${method}_auto_paging(${argsAll.join(', ')}) -> impl futures_util::Stream<Item = Result<${itemType}, Error>> + '_ {`;
  if (optsSig.length <= 110) {
    sig.push(optsSig);
  } else {
    sig.push(`    pub fn ${method}_auto_paging(`);
    for (const arg of argsAll) sig.push(`        ${arg},`);
    sig.push(`    ) -> impl futures_util::Stream<Item = Result<${itemType}, Error>> + '_ {`);
  }

  for (const n of pathArgNames) {
    sig.push(`        let ${n}: String = ${n}.into();`);
  }
  sig.push('        crate::pagination::auto_paginate_pages(move |after| {');
  for (const n of pathArgNames) sig.push(`            let ${n} = ${n}.clone();`);
  sig.push('            let mut params = params.clone();');
  sig.push(`            params.${cursorField} = after;`);
  sig.push('            async move {');
  const callArgs = [...pathArgNames.map((n) => `&${n}`), 'params'].join(', ');
  sig.push(`                let page = self.${method}(${callArgs}).await?;`);
  sig.push(`                Ok((page.${dataAccessor}, page.list_metadata.${cursorField}))`);
  sig.push('            }');
  sig.push('        })');
  sig.push('    }');

  return sig.join('\n');
}

function renderWrapperParamsStruct(
  name: string,
  _op: Operation,
  _wrapper: ResolvedWrapper,
  params: ResolvedWrapperParam[],
  registry: UnionRegistry,
  ctx: EmitterContext,
): string {
  type FieldInfo = {
    fname: string;
    rust: string;
    required: boolean;
    defaultExpr: string | null;
  };
  const fields: FieldInfo[] = [];
  const fieldLines: string[] = [];
  const seen = new Set<string>();
  for (const rp of params) {
    const fname = fieldName(rp.paramName);
    if (seen.has(fname)) continue;
    seen.add(fname);
    let rust: string;
    if (rp.field) {
      rust = mapTypeRef(rp.field.type, {
        hint: `${name}${typeName(rp.paramName)}`,
        registry,
      });
    } else {
      rust = 'String';
    }
    if (rp.isOptional && !rust.startsWith('Option<')) rust = makeOptional(rust);
    rust = applySecretRedaction(rust, rp.paramName);
    const desc = rp.field?.description?.trim();
    if (desc) {
      for (const c of paramDocComment(desc)) fieldLines.push(`    ${c}`);
    }
    const fieldDefault = rp.field?.default;
    if (fieldDefault != null) {
      if (desc) fieldLines.push('    ///');
      fieldLines.push(`    /// Defaults to \`${formatDefault(fieldDefault)}\`.`);
    }
    const required = !rp.isOptional && !rust.startsWith('Option<');
    if (required) {
      if (desc || fieldDefault != null) fieldLines.push('    ///');
      fieldLines.push('    /// Required.');
    }
    if (rust.startsWith('Option<')) {
      fieldLines.push('    #[serde(skip_serializing_if = "Option::is_none")]');
    }
    if (fname !== rp.paramName) {
      fieldLines.push(`    #[serde(rename = ${JSON.stringify(rp.paramName)})]`);
    }
    fieldLines.push(`    pub ${fname}: ${rust},`);
    const defaultExpr =
      fieldDefault != null && rp.field
        ? rustDefaultExpr(fieldDefault, rp.field.type, rust.startsWith('Option<'), ctx)
        : null;
    fields.push({ fname, rust, required, defaultExpr });
  }

  // Mirror the regular params struct: derive `Default` only when every field
  // is optional and no field carries a spec-level default; spec defaults need
  // a manual `impl Default` (Option<T>::default() is None).
  const requiredFields = fields.filter((f) => f.required);
  const allOptional = fields.length === 0 || requiredFields.length === 0;
  const hasSpecDefault = fields.some((f) => f.defaultExpr !== null);
  const canDeriveDefault = allOptional && !hasSpecDefault;
  const derives = canDeriveDefault ? 'Debug, Clone, Default, Serialize' : 'Debug, Clone, Serialize';

  const out: string[] = [];
  if (fieldLines.length === 0) {
    out.push(`#[derive(${derives})]`, `pub struct ${name} {}`);
  } else {
    out.push(`#[derive(${derives})]`, `pub struct ${name} {`, ...fieldLines, '}');
  }

  if (allOptional && hasSpecDefault) {
    const defaultInitLines = fields.map((f) => `            ${f.fname}: ${f.defaultExpr ?? 'Default::default()'},`);
    out.push('');
    out.push(`impl Default for ${name} {`);
    out.push('    fn default() -> Self {');
    out.push('        Self {');
    out.push(...defaultInitLines);
    out.push('        }');
    out.push('    }');
    out.push('}');
  }

  if (requiredFields.length > 0) {
    const ctorArgs = requiredFields.map((f) => `${f.fname}: ${ctorParamType(f.rust)}`).join(', ');
    const initLines: string[] = [];
    for (const f of fields) {
      if (f.required) {
        const value = ctorParamConvert(f.rust, f.fname);
        initLines.push(value === f.fname ? `            ${f.fname},` : `            ${f.fname}: ${value},`);
      } else {
        initLines.push(`            ${f.fname}: ${f.defaultExpr ?? 'Default::default()'},`);
      }
    }
    out.push('');
    out.push(`impl ${name} {`);
    out.push(`    /// Construct a new \`${name}\` with the required fields set.`);
    out.push(`    pub fn new(${ctorArgs}) -> Self {`);
    out.push('        Self {');
    out.push(...initLines);
    out.push('        }');
    out.push('    }');
    out.push('}');
  }

  return out.join('\n');
}

function renderWrapperMethod(
  op: Operation,
  wrapper: ResolvedWrapper,
  params: ResolvedWrapperParam[],
  paramsType: string,
  method: string,
): string {
  const segments = parsePathTemplate(op.path);
  const pathArgList = op.pathParams.map((p) => `${methodName(p.name)}: &str`);
  const pathArgNames = op.pathParams.map((p) => methodName(p.name));
  const returnType = wrapper.responseModelName ? typeName(wrapper.responseModelName) : renderResponseType(op);

  const sig: string[] = [];
  const docLines: string[] = [];
  const desc = (op.description ?? '').trim();
  if (desc) {
    for (const raw of desc.split('\n')) {
      const t = raw.trim();
      docLines.push(t.length === 0 ? '    ///' : `    /// ${t}`);
    }
  } else {
    docLines.push(`    /// ${op.httpMethod.toUpperCase()} ${op.path} (${wrapper.name})`);
  }

  // Convenience method — delegates to `_with_options`.
  sig.push(...docLines);
  if (op.deprecated) sig.push('    #[deprecated]');
  const argsConvenience = ['&self', ...pathArgList, `params: ${paramsType}`];
  const convenienceSig = `    pub async fn ${method}(${argsConvenience.join(', ')}) -> Result<${returnType}, Error> {`;
  if (convenienceSig.length <= 100) {
    sig.push(convenienceSig);
  } else {
    sig.push(`    pub async fn ${method}(`);
    for (const arg of argsConvenience) sig.push(`        ${arg},`);
    sig.push(`    ) -> Result<${returnType}, Error> {`);
  }
  const delegateArgs = [...pathArgNames, 'params', 'None'].join(', ');
  sig.push(`        self.${method}_with_options(${delegateArgs}).await`);
  sig.push('    }');
  sig.push('');

  // `_with_options` variant.
  sig.push(`    /// Variant of [\`Self::${method}\`] that accepts per-request [\`crate::RequestOptions\`].`);
  if (op.deprecated) sig.push('    #[deprecated]');
  const argsOpts = ['&self', ...pathArgList, `params: ${paramsType}`, 'options: Option<&crate::RequestOptions>'];
  const optsSig = `    pub async fn ${method}_with_options(${argsOpts.join(', ')}) -> Result<${returnType}, Error> {`;
  if (optsSig.length <= 100) {
    sig.push(optsSig);
  } else {
    sig.push(`    pub async fn ${method}_with_options(`);
    for (const arg of argsOpts) sig.push(`        ${arg},`);
    sig.push(`    ) -> Result<${returnType}, Error> {`);
  }

  const pathFormat = segments
    .map((s) => (s.kind === 'literal' ? s.value : `{${methodName(s.name as string)}}`))
    .join('');
  const pathHasParams = segments.some((s) => s.kind === 'param');

  if (pathHasParams) {
    for (const p of op.pathParams) {
      const n = methodName(p.name);
      sig.push(`        let ${n} = crate::client::path_segment(${n});`);
    }
    sig.push(`        let path = format!(${JSON.stringify(pathFormat)});`);
  } else {
    sig.push(`        let path = ${JSON.stringify(pathFormat)}.to_string();`);
  }

  sig.push(`        let method = http::Method::${op.httpMethod.toUpperCase()};`);

  // Build the JSON body inline: defaults + inferFromClient (read from the
  // client at request time) + each exposed param.
  sig.push('        let body = serde_json::json!({');
  for (const [k, v] of Object.entries(wrapper.defaults ?? {})) {
    sig.push(`            ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  }
  for (const k of wrapper.inferFromClient ?? []) {
    sig.push(`            ${JSON.stringify(k)}: ${clientFieldExpression(k)},`);
  }
  for (const rp of params) {
    sig.push(`            ${JSON.stringify(rp.paramName)}: params.${fieldName(rp.paramName)},`);
  }
  sig.push('        });');

  sig.push('        #[derive(Serialize)]');
  sig.push('        struct EmptyQuery {}');
  sig.push('        self.client');
  sig.push('            .request_with_body_opts(method, &path, &EmptyQuery {}, Some(&body), options)');
  sig.push('            .await');
  sig.push('    }');

  return sig.join('\n');
}

/**
 * Rust expression for reading a client-config field at request time. Mirrors
 * the Go emitter's `clientFieldExpression`. Falls back to an empty literal
 * for unknown fields so the body still compiles.
 */
function clientFieldExpression(field: string): string {
  switch (field) {
    case 'client_id':
      return 'self.client.client_id()';
    case 'client_secret':
      return 'self.client.api_key()';
    default:
      return '""';
  }
}

/** Multi-line `///` doc comment from a free-form description. */
function paramDocComment(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `/// ${l}`);
}

/**
 * Render a spec-level default value for inclusion in a doc comment. Strings
 * render bare (e.g. `desc`) so they nest naturally inside the surrounding
 * backticks; numbers/booleans use JSON encoding.
 */
function formatDefault(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Render a spec-level default value as a Rust expression suitable for an
 * `impl Default` body or a `new(…)` initialiser. When `isOptional` is true the
 * result is wrapped in `Some(…)` so it matches an `Option<T>` field.
 *
 * Returns `null` for types/values the emitter doesn't know how to materialise
 * — caller falls back to `Default::default()`.
 */
function rustDefaultExpr(value: unknown, ref: TypeRef, isOptional: boolean, ctx: EmitterContext): string | null {
  if (ref.kind === 'nullable') {
    return rustDefaultExpr(value, ref.inner, isOptional, ctx);
  }

  let expr: string | null = null;
  switch (ref.kind) {
    case 'primitive':
      if (ref.type === 'integer' && typeof value === 'number' && Number.isFinite(value)) {
        expr = String(Math.trunc(value));
      } else if (ref.type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
        // Floats need a decimal point so the literal parses as `f64`, not `i32`.
        expr = Number.isInteger(value) ? `${value}.0` : String(value);
      } else if (ref.type === 'boolean' && typeof value === 'boolean') {
        expr = String(value);
      } else if (ref.type === 'string' && typeof value === 'string') {
        expr = `${JSON.stringify(value)}.to_string()`;
      }
      break;
    case 'enum': {
      if (typeof value !== 'string' && typeof value !== 'number') break;
      const enumDef = ctx.spec.enums.find((e) => e.name === ref.name);
      if (!enumDef) break;
      const ev = enumDef.values.find((v) => v.value === value);
      if (!ev) break;
      expr = `${typeName(ref.name)}::${variantName(ev.value)}`;
      break;
    }
    default:
      break;
  }

  if (expr === null) return null;
  return isOptional ? `Some(${expr})` : expr;
}

function methodDocLines(op: Operation): string[] {
  const lines: string[] = [];
  if (op.description && op.description.trim().length > 0) {
    for (const raw of op.description.split('\n')) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        lines.push('///');
      } else {
        lines.push(`/// ${trimmed}`);
      }
    }
  } else {
    lines.push(`/// ${op.httpMethod.toUpperCase()} ${op.path}`);
  }
  return lines;
}

function renderResponseType(op: Operation): string {
  if (isEmptyResponse(op)) return '()';
  return mapTypeRef(op.response!);
}

/**
 * True when the operation has no usable response schema. We treat the IR's
 * `primitive: unknown` and missing-response cases the same way: the spec
 * declared no JSON body, so the SDK promises nothing about the contents.
 * Returning `Result<(), Error>` is more honest than handing back a
 * `serde_json::Value` that's almost always `Object({})` — and it lets the
 * caller `?` the result without an unused-variable warning.
 */
function isEmptyResponse(op: Operation): boolean {
  if (!op.response) return true;
  if (op.response.kind === 'primitive' && op.response.type === 'unknown') return true;
  return false;
}

/** Treat a body as optional when the IR wraps it in `nullable`. */
function isBodyRequired(op: Operation): boolean {
  return op.requestBody !== undefined && op.requestBody.kind !== 'nullable';
}

/**
 * `true` when the resolved operation contributes nothing to a params struct:
 * no request body, and every exposed query/header/cookie parameter is
 * inferred from the client or supplied as a default. Such methods take no
 * `params:` arg in the public API and skip the empty struct entirely.
 */
function isEmptyParams(op: Operation, resolved: ResolvedOperation): boolean {
  if (op.requestBody) return false;
  const hidden = new Set<string>([...Object.keys(resolved.defaults ?? {}), ...(resolved.inferFromClient ?? [])]);
  const grouped = new Set<string>();
  for (const g of op.parameterGroups ?? []) {
    for (const v of g.variants) for (const p of v.parameters) grouped.add(p.name);
  }
  const visibleQuery = op.queryParams.filter((p) => !hidden.has(p.name) && !grouped.has(p.name));
  const visibleHeader = op.headerParams.filter((p) => !hidden.has(p.name));
  const visibleCookie = (op.cookieParams ?? []).filter((p) => !hidden.has(p.name));
  return (
    visibleQuery.length === 0 &&
    visibleHeader.length === 0 &&
    visibleCookie.length === 0 &&
    (op.parameterGroups?.length ?? 0) === 0
  );
}

function renderResourcesBarrel(exports: { module: string; struct: string }[]): string {
  const seen = new Set<string>();
  const unique: { module: string; struct: string }[] = [];
  for (const e of exports) {
    if (seen.has(e.module)) continue;
    seen.add(e.module);
    unique.push(e);
  }
  unique.sort((a, b) => a.module.localeCompare(b.module));

  const lines: string[] = [];
  for (const { module } of unique) lines.push(`pub mod ${module};`);
  lines.push('');
  for (const { module, struct } of unique) lines.push(`pub use ${module}::${struct};`);
  return lines.join('\n') + '\n';
}

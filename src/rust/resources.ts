import type {
  Service,
  Operation,
  EmitterContext,
  GeneratedFile,
  Parameter,
  ResolvedOperation,
  ResolvedWrapper,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { fieldName, methodName, typeName, moduleName } from './naming.js';
import { mapTypeRef, makeOptional, UnionRegistry } from './type-map.js';
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
        paramsStructs.push(renderWrapperParamsStruct(paramsType, op, wrapper, params, registry));
        methods.push(renderWrapperMethod(op, wrapper, params, paramsType, wrapperMethodName));
      }
      continue;
    }

    const m = methodName(resolved.methodName);
    if (seenMethods.has(m)) continue;
    seenMethods.add(m);
    const paramsType = `${typeName(resolved.methodName)}Params`;
    const emptyParams = isEmptyParams(op, resolved);
    if (!emptyParams) {
      paramsStructs.push(renderParamsStruct(paramsType, op, resolved, registry));
    }
    methods.push(renderMethod(op, resolved, paramsType, m, emptyParams));

    // For paginated list endpoints, also emit `<method>_auto_paging` returning
    // `impl Stream<Item = Result<T, Error>>`. Detected by:
    //   - response is a model with both `data: Vec<T>` and `list_metadata`
    //   - the params struct has an `after` cursor field
    const autoPaging = renderAutoPagingMethod(op, resolved, paramsType, m, ctx);
    if (autoPaging) methods.push(autoPaging);
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

function renderParamsStruct(name: string, op: Operation, resolved: ResolvedOperation, registry: UnionRegistry): string {
  const bodyRequired = isBodyRequired(op);
  const hidden = new Set<string>([...Object.keys(resolved.defaults ?? {}), ...(resolved.inferFromClient ?? [])]);

  type FieldInfo = { fname: string; rust: string; required: boolean; doc?: string };
  const fields: FieldInfo[] = [];
  const fieldLines: string[] = [];
  const seen = new Set<string>();
  const emitField = (p: Parameter) => {
    if (hidden.has(p.name)) return;
    const fname = fieldName(p.name);
    if (seen.has(fname)) return;
    seen.add(fname);
    let rust = mapTypeRef(p.type, { hint: `${name}${typeName(p.name)}`, registry });
    if (!p.required && !rust.startsWith('Option<')) rust = makeOptional(rust);
    // Field-level documentation derived from the spec.
    const desc = p.description?.trim();
    if (desc) {
      for (const c of paramDocComment(desc)) fieldLines.push(`    ${c}`);
    }
    if (p.required && !rust.startsWith('Option<')) {
      if (desc) fieldLines.push('    ///');
      fieldLines.push('    /// Required.');
    }
    if (rust.startsWith('Option<')) {
      fieldLines.push('    #[serde(skip_serializing_if = "Option::is_none")]');
    }
    if (fname !== p.name) {
      fieldLines.push(`    #[serde(rename = ${JSON.stringify(p.name)})]`);
    }
    if (p.deprecated) fieldLines.push('    #[deprecated]');
    fieldLines.push(`    pub ${fname}: ${rust},`);
    fields.push({ fname, rust, required: !!p.required && !rust.startsWith('Option<') });
  };

  for (const p of op.queryParams) emitField(p);
  for (const p of op.headerParams) emitField(p);

  if (op.requestBody) {
    let bodyType = mapTypeRef(op.requestBody, { hint: `${name}Body`, registry });
    if (!bodyRequired && !bodyType.startsWith('Option<')) {
      bodyType = makeOptional(bodyType);
    }
    fieldLines.push('    /// Request body sent with this call.');
    if (bodyRequired) fieldLines.push('    ///');
    if (bodyRequired) fieldLines.push('    /// Required.');
    fieldLines.push('    #[serde(skip)]');
    fieldLines.push(`    pub body: ${bodyType},`);
    fields.push({ fname: 'body', rust: bodyType, required: bodyRequired });
  }

  // Default-derive only when every field is optional (so Default can't
  // construct a "valid" value with empty strings for required fields).
  const requiredFields = fields.filter((f) => f.required);
  const allOptional = fields.length === 0 || requiredFields.length === 0;
  const derives = allOptional ? 'Debug, Clone, Default, Serialize' : 'Debug, Clone, Serialize';

  const out: string[] = [];
  if (fieldLines.length === 0) {
    out.push(`#[derive(${derives})]`, `pub struct ${name} {}`);
  } else {
    out.push(`#[derive(${derives})]`, `pub struct ${name} {`, ...fieldLines, '}');
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
        initLines.push(`            ${f.fname}: Default::default(),`);
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

/** Constructor parameter type — accept `impl Into<String>` for ergonomic strings. */
function ctorParamType(rust: string): string {
  if (rust === 'String') return 'impl Into<String>';
  return rust;
}

function ctorParamConvert(rust: string, name: string): string {
  if (rust === 'String') return `${name}.into()`;
  return name;
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

  const sig: string[] = [];

  // Convenience method — no per-request options. Delegates to `_with_options`.
  for (const line of methodDocLines(op)) sig.push(`    ${line}`);
  if (op.deprecated) sig.push('    #[deprecated]');
  const argsConvenience = ['&self', ...pathArgList, ...(emptyParams ? [] : [`params: ${paramsType}`])];
  const convenienceSig = `    pub async fn ${method}(${argsConvenience.join(', ')}) -> Result<${returnType}, Error> {`;
  if (convenienceSig.length <= 100) {
    sig.push(convenienceSig);
  } else {
    sig.push(`    pub async fn ${method}(`);
    for (const arg of argsConvenience) sig.push(`        ${arg},`);
    sig.push(`    ) -> Result<${returnType}, Error> {`);
  }
  const delegateArgs = [...pathArgNames, ...(emptyParams ? [] : ['params']), 'None'].join(', ');
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
    sig.push(`        let path = format!(${JSON.stringify(pathFormat)});`);
  } else {
    sig.push(`        let path = ${JSON.stringify(pathFormat)}.to_string();`);
  }

  sig.push(`        let method = http::Method::${op.httpMethod.toUpperCase()};`);

  // For empty-params endpoints, pass `&()` as the (empty) query — `()`
  // serialises to nothing under serde, matching the previous empty-struct
  // behaviour without surfacing the struct in the public API.
  const queryRef = emptyParams ? '&()' : '&params';

  if (op.requestBody) {
    sig.push('        self.client');
    if (bodyRequired) {
      sig.push(`            .request_with_body_opts(method, &path, ${queryRef}, Some(&params.body), options)`);
    } else {
      sig.push(`            .request_with_body_opts(method, &path, ${queryRef}, params.body.as_ref(), options)`);
    }
    sig.push('            .await');
  } else {
    sig.push('        self.client');
    sig.push(`            .request_with_query_opts(method, &path, ${queryRef}, options)`);
    sig.push('            .await');
  }

  sig.push('    }');

  void plan;
  void resolved;
  return sig.join('\n');
}

/**
 * Generate a `<method>_auto_paging` helper for paginated list endpoints.
 * Returns null when the operation isn't a recognised list endpoint (response
 * model lacks both `data: Vec<T>` and `list_metadata`, or the params struct
 * has no `after` cursor).
 */
function renderAutoPagingMethod(
  op: Operation,
  _resolved: ResolvedOperation,
  paramsType: string,
  method: string,
  ctx: EmitterContext,
): string | null {
  if (!op.response || op.response.kind !== 'model') return null;
  const responseModel = ctx.spec.models.find((m) => m.name === op.response!.name);
  if (!responseModel) return null;

  const dataField = responseModel.fields.find((f) => f.name === 'data');
  const hasListMetadata = responseModel.fields.some((f) => f.name === 'list_metadata');
  if (!dataField || !hasListMetadata) return null;
  if (dataField.type.kind !== 'array') return null;

  const itemType = mapTypeRef(dataField.type.items);
  // Require an `after` cursor in the params (query params).
  const hasAfter = op.queryParams.some((p) => p.name === 'after');
  if (!hasAfter) return null;

  // Path args are taken by owned `String` so the returned stream borrows
  // nothing but `&self`. This keeps the lifetime story simple — only `'_`
  // (the `&self` lifetime) is needed on the returned `impl Stream`.
  const pathArgList = op.pathParams.map((p) => `${methodName(p.name)}: impl Into<String>`);
  const pathArgNames = op.pathParams.map((p) => methodName(p.name));

  const sig: string[] = [];
  sig.push('');
  sig.push(`    /// Returns an async [\`futures_util::Stream\`] that yields every \`${itemType}\``);
  sig.push(`    /// across all pages, advancing the \`after\` cursor under the hood.`);
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

  sig.push('        use futures_util::TryStreamExt;');
  for (const n of pathArgNames) {
    sig.push(`        let ${n}: String = ${n}.into();`);
  }
  const initialTuple = ['Some(params)', ...pathArgNames, 'self'].join(', ');
  sig.push(`        let initial = (${initialTuple});`);
  const moveTuple = ['maybe_params', ...pathArgNames, 'this'].join(', ');
  sig.push(`        futures_util::stream::try_unfold(initial, move |(${moveTuple})| async move {`);
  sig.push('            let Some(params) = maybe_params else {');
  sig.push('                return Ok::<_, Error>(None);');
  sig.push('            };');
  const callArgs = [...pathArgNames.map((n) => `&${n}`), 'params.clone()'].join(', ');
  sig.push(`            let page = this.${method}(${callArgs}).await?;`);
  sig.push('            let next_after = page.list_metadata.after.clone();');
  sig.push('            let next = next_after.map(|after| {');
  sig.push('                let mut p = params;');
  sig.push('                p.after = Some(after);');
  sig.push('                p');
  sig.push('            });');
  sig.push('            let chunk = futures_util::stream::iter(');
  sig.push(`                page.data.into_iter().map(Ok::<${itemType}, Error>),`);
  sig.push('            );');
  const nextTuple = ['next', ...pathArgNames, 'this'].join(', ');
  sig.push(`            Ok::<_, Error>(Some((chunk, (${nextTuple}))))`);
  sig.push('        })');
  sig.push('        .try_flatten()');
  sig.push('    }');

  return sig.join('\n');
}

function renderWrapperParamsStruct(
  name: string,
  _op: Operation,
  _wrapper: ResolvedWrapper,
  params: ResolvedWrapperParam[],
  registry: UnionRegistry,
): string {
  const fieldLines: string[] = [];
  const seen = new Set<string>();
  for (const rp of params) {
    const fname = fieldName(rp.paramName);
    if (seen.has(fname)) continue;
    seen.add(fname);
    let rust: string;
    if (rp.field) {
      rust = mapTypeRef(rp.field.type, { hint: `${name}${typeName(rp.paramName)}`, registry });
    } else {
      rust = 'String';
    }
    if (rp.isOptional && !rust.startsWith('Option<')) rust = makeOptional(rust);
    const desc = rp.field?.description?.trim();
    if (desc) {
      for (const c of paramDocComment(desc)) fieldLines.push(`    ${c}`);
    }
    if (!rp.isOptional && !rust.startsWith('Option<')) {
      if (desc) fieldLines.push('    ///');
      fieldLines.push('    /// Required.');
    }
    if (rust.startsWith('Option<')) {
      fieldLines.push('    #[serde(skip_serializing_if = "Option::is_none")]');
    }
    if (fname !== rp.paramName) {
      fieldLines.push(`    #[serde(rename = ${JSON.stringify(rp.paramName)})]`);
    }
    fieldLines.push(`    pub ${fname}: ${rust},`);
  }

  if (fieldLines.length === 0) {
    return ['#[derive(Debug, Clone, Default, Serialize)]', `pub struct ${name} {}`].join('\n');
  }
  return ['#[derive(Debug, Clone, Default, Serialize)]', `pub struct ${name} {`, ...fieldLines, '}'].join('\n');
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
  if (!op.response || (op.response.kind === 'primitive' && op.response.type === 'unknown')) {
    return 'serde_json::Value';
  }
  return mapTypeRef(op.response);
}

/** Treat a body as optional when the IR wraps it in `nullable`. */
function isBodyRequired(op: Operation): boolean {
  return op.requestBody !== undefined && op.requestBody.kind !== 'nullable';
}

/**
 * `true` when the resolved operation contributes nothing to a params struct:
 * no request body, and every exposed query/header parameter is inferred from
 * the client or supplied as a default. Such methods take no `params:` arg in
 * the public API and skip the empty struct entirely.
 */
function isEmptyParams(op: Operation, resolved: ResolvedOperation): boolean {
  if (op.requestBody) return false;
  const hidden = new Set<string>([...Object.keys(resolved.defaults ?? {}), ...(resolved.inferFromClient ?? [])]);
  const visibleQuery = op.queryParams.filter((p) => !hidden.has(p.name));
  const visibleHeader = op.headerParams.filter((p) => !hidden.has(p.name));
  return visibleQuery.length === 0 && visibleHeader.length === 0;
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

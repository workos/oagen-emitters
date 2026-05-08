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
    });
  }

  files.push({
    path: 'src/resources/mod.rs',
    content: renderResourcesBarrel(exports),
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
    paramsStructs.push(renderParamsStruct(paramsType, op, resolved, registry));
    methods.push(renderMethod(op, resolved, paramsType, m));
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
  const derives = bodyRequired ? 'Debug, Clone, Serialize' : 'Debug, Clone, Default, Serialize';

  const fieldLines: string[] = [];
  const seen = new Set<string>();
  const emitField = (p: Parameter) => {
    if (hidden.has(p.name)) return;
    const fname = fieldName(p.name);
    if (seen.has(fname)) return;
    seen.add(fname);
    let rust = mapTypeRef(p.type, { hint: `${name}${typeName(p.name)}`, registry });
    if (!p.required && !rust.startsWith('Option<')) rust = makeOptional(rust);
    if (rust.startsWith('Option<')) {
      fieldLines.push('    #[serde(skip_serializing_if = "Option::is_none")]');
    }
    if (fname !== p.name) {
      fieldLines.push(`    #[serde(rename = ${JSON.stringify(p.name)})]`);
    }
    if (p.deprecated) fieldLines.push('    #[deprecated]');
    fieldLines.push(`    pub ${fname}: ${rust},`);
  };

  for (const p of op.queryParams) emitField(p);
  for (const p of op.headerParams) emitField(p);

  if (op.requestBody) {
    let bodyType = mapTypeRef(op.requestBody, { hint: `${name}Body`, registry });
    if (!bodyRequired && !bodyType.startsWith('Option<')) {
      bodyType = makeOptional(bodyType);
    }
    fieldLines.push('    #[serde(skip)]');
    fieldLines.push(`    pub body: ${bodyType},`);
  }

  if (fieldLines.length === 0) {
    return [`#[derive(${derives})]`, `pub struct ${name} {}`].join('\n');
  }

  return [`#[derive(${derives})]`, `pub struct ${name} {`, ...fieldLines, '}'].join('\n');
}

function renderMethod(op: Operation, resolved: ResolvedOperation, paramsType: string, method: string): string {
  const plan = planOperation(op);
  const segments = parsePathTemplate(op.path);
  const pathArgList = op.pathParams.map((p) => `${methodName(p.name)}: &str`);

  const returnType = renderResponseType(op);
  const bodyRequired = isBodyRequired(op);

  const sig: string[] = [];
  for (const line of methodDocLines(op)) sig.push(`    ${line}`);
  if (op.deprecated) sig.push('    #[deprecated]');

  const argsAll = ['&self', ...pathArgList, `params: ${paramsType}`];
  const singleLineSig = `    pub async fn ${method}(${argsAll.join(', ')}) -> Result<${returnType}, Error> {`;
  if (singleLineSig.length <= 100) {
    sig.push(singleLineSig);
  } else {
    sig.push(`    pub async fn ${method}(`);
    for (const arg of argsAll) sig.push(`        ${arg},`);
    sig.push(`    ) -> Result<${returnType}, Error> {`);
  }

  const pathFormat = segments.map((s) => (s.kind === 'literal' ? s.value : '{}')).join('');
  const pathInterps = segments.filter((s) => s.kind === 'param').map((s) => methodName(s.name as string));

  if (pathInterps.length > 0) {
    const formatArgs = `${JSON.stringify(pathFormat)}, ${pathInterps.join(', ')}`;
    const oneLine = `        let path = format!(${formatArgs});`;
    if (formatArgs.length <= 60 && oneLine.length <= 100) {
      sig.push(oneLine);
    } else {
      sig.push('        let path = format!(');
      sig.push(`            ${JSON.stringify(pathFormat)},`);
      sig.push(`            ${pathInterps.join(', ')}`);
      sig.push('        );');
    }
  } else {
    sig.push(`        let path = ${JSON.stringify(pathFormat)}.to_string();`);
  }

  sig.push(`        let method = http::Method::${op.httpMethod.toUpperCase()};`);

  if (op.requestBody) {
    sig.push('        self.client');
    if (bodyRequired) {
      sig.push('            .request_with_body(method, &path, &params, Some(&params.body))');
    } else {
      sig.push('            .request_with_body(method, &path, &params, params.body.as_ref())');
    }
    sig.push('            .await');
  } else {
    sig.push('        self.client.request_with_query(method, &path, &params).await');
  }

  sig.push('    }');

  void plan;
  void resolved;
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
  const returnType = wrapper.responseModelName ? typeName(wrapper.responseModelName) : renderResponseType(op);

  const sig: string[] = [];
  const desc = (op.description ?? '').trim();
  if (desc) {
    for (const raw of desc.split('\n')) {
      const t = raw.trim();
      sig.push(t.length === 0 ? '    ///' : `    /// ${t}`);
    }
  } else {
    sig.push(`    /// ${op.httpMethod.toUpperCase()} ${op.path} (${wrapper.name})`);
  }
  if (op.deprecated) sig.push('    #[deprecated]');

  const argsAll = ['&self', ...pathArgList, `params: ${paramsType}`];
  const singleLineSig = `    pub async fn ${method}(${argsAll.join(', ')}) -> Result<${returnType}, Error> {`;
  if (singleLineSig.length <= 100) {
    sig.push(singleLineSig);
  } else {
    sig.push(`    pub async fn ${method}(`);
    for (const arg of argsAll) sig.push(`        ${arg},`);
    sig.push(`    ) -> Result<${returnType}, Error> {`);
  }

  const pathFormat = segments.map((s) => (s.kind === 'literal' ? s.value : '{}')).join('');
  const pathInterps = segments.filter((s) => s.kind === 'param').map((s) => methodName(s.name as string));

  if (pathInterps.length > 0) {
    const formatArgs = `${JSON.stringify(pathFormat)}, ${pathInterps.join(', ')}`;
    const oneLine = `        let path = format!(${formatArgs});`;
    if (formatArgs.length <= 60 && oneLine.length <= 100) {
      sig.push(oneLine);
    } else {
      sig.push('        let path = format!(');
      sig.push(`            ${JSON.stringify(pathFormat)},`);
      sig.push(`            ${pathInterps.join(', ')}`);
      sig.push('        );');
    }
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
  sig.push('            .request_with_body(method, &path, &EmptyQuery {}, Some(&body))');
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

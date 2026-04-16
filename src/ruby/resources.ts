import type { Service, EmitterContext, GeneratedFile, Operation, TypeRef, Parameter, Model } from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { className, fieldName, fileName, methodName, safeParamName, resolveMethodName } from './naming.js';
import { mapTypeRefForYard } from './type-map.js';
import {
  buildResolvedLookup,
  lookupResolved,
  groupByMount,
  getOpDefaults,
  getOpInferFromClient,
  buildHiddenParams,
  collectGroupedParamNames,
} from '../shared/resolved-ops.js';
import { isListWrapperModel } from '../shared/model-utils.js';
import { generateWrapperMethods, collectWrapperResponseModels } from './wrappers.js';

/**
 * Generate Ruby resource (service) classes from IR services.
 *
 * Produces one `.rb` file per mount target under `lib/workos/`.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  const groups = groupByMount(ctx);
  const lookup = buildResolvedLookup(ctx);
  const modelNames = new Set(ctx.spec.models.map((m) => m.name));
  const enumNames = new Set(ctx.spec.enums.map((e) => e.name));
  const modelByName = new Map<string, Model>();
  for (const m of ctx.spec.models as Model[]) modelByName.set(m.name, m);

  // Build a map of model.name -> isListWrapper to detect pagination.
  const listWrapperModels = new Map<string, Model>();
  for (const m of ctx.spec.models as Model[]) {
    if (isListWrapperModel(m)) listWrapperModels.set(m.name, m);
  }

  for (const [mountTarget, group] of groups) {
    const cls = className(mountTarget);
    const file = fileName(mountTarget);

    const operations = group.operations;
    if (operations.length === 0) continue;

    const requires = new Set<string>();
    requires.add('json');

    const lines: string[] = [];
    const methodBodies: string[] = [];

    const emittedMethodNames = new Set<string>();

    // We look for each operation's "home" service within this group.
    for (const op of operations) {
      // Find the service that owns this op (via resolvedOps -> service mapping).
      const ownerService =
        group.resolvedOps.find((r) => r.operation === op)?.service ??
        services.find((s) => s.operations.includes(op)) ??
        services[0];
      const method = resolveMethodName(op, ownerService, ctx);
      if (emittedMethodNames.has(method)) continue;

      const resolved = lookupResolved(op, lookup);
      // Skip url-builder operations: these are spec-marked client-side URL
      // constructors (no HTTP), and the Ruby SDK provides them via
      // hand-maintained inline @oagen-ignore extensions on the relevant
      // service class instead of generating an HTTP wrapper that would
      // incorrectly hit the API.
      if (resolved?.urlBuilder) {
        emittedMethodNames.add(method);
        continue;
      }

      emittedMethodNames.add(method);

      const defaults = getOpDefaults(resolved);
      const inferFromClient = new Set(getOpInferFromClient(resolved));
      const hiddenParams = buildHiddenParams(resolved);

      const body = emitMethod({
        op,
        method,
        defaults,
        inferFromClient,
        hiddenParams,
        enumNames,
        modelNames,
        modelByName,
        listWrapperModels,
        requires,
      });
      methodBodies.push(body);

      // Emit union split wrapper methods (e.g., authenticate_with_password).
      if (resolved?.wrappers && resolved.wrappers.length > 0) {
        const wrapperBodies = generateWrapperMethods(resolved, ctx, modelNames, requires);
        for (let i = 0; i < resolved.wrappers.length; i++) {
          const w = resolved.wrappers[i];
          if (emittedMethodNames.has(w.name)) continue;
          emittedMethodNames.add(w.name);
          methodBodies.push(wrapperBodies[i]);
          if (
            w.responseModelName &&
            modelNames.has(w.responseModelName) &&
            !listWrapperModels.has(w.responseModelName)
          ) {
            requires.add(fileName(w.responseModelName));
          }
        }
        // Also ensure any additional response models are added to requires set.
        for (const m of collectWrapperResponseModels(resolved)) {
          if (modelNames.has(m) && !listWrapperModels.has(m)) requires.add(fileName(m));
        }
      }
    }

    // Zeitwerk autoloads every WorkOS::* constant; only stdlib requires.
    if (requires.has('json')) {
      lines.push(`require 'json'`);
      lines.push('');
    }
    lines.push('module WorkOS');
    lines.push(`  class ${cls}`);
    lines.push('    def initialize(client)');
    lines.push('      @client = client');
    lines.push('    end');
    for (const body of methodBodies) {
      lines.push('');
      lines.push(body);
    }
    lines.push('  end');
    lines.push('end');

    files.push({
      path: `lib/workos/${file}.rb`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  return files;
}

/** Build a single Ruby method from an Operation. */
function emitMethod(args: {
  op: Operation;
  method: string;
  defaults: Record<string, string | number | boolean>;
  inferFromClient: Set<string>;
  hiddenParams: Set<string>;
  enumNames: Set<string>;
  modelNames: Set<string>;
  modelByName: Map<string, Model>;
  listWrapperModels: Map<string, Model>;
  requires: Set<string>;
}): string {
  const {
    op,
    method,
    defaults,
    inferFromClient,
    hiddenParams,
    enumNames,
    modelNames,
    modelByName,
    listWrapperModels,
    requires,
  } = args;
  void enumNames;

  const plan = planOperation(op);
  const lines: string[] = [];

  // Collect params: path params positional, others keyword.
  const pathParams = op.pathParams ?? [];
  const groupedParamNames = collectGroupedParamNames(op);
  const queryParams = (op.queryParams ?? []).filter((q) => !groupedParamNames.has(q.name));

  // Request body params: if body is a model, expand its fields.
  const bodyFields = getRequestBodyFields(op, hiddenParams, modelByName);

  // Detect path/body name collisions and build a rename map for body fields.
  // When a body field's snake_case name matches a path param, prefix with "body_"
  // so the Ruby method exposes distinct keyword args.
  const pathParamNames = new Set(pathParams.map((p) => safeParamName(p.name)));
  const bodyFieldRenames = new Map<string, string>();
  for (const f of bodyFields) {
    if (hiddenParams.has(f.name)) continue;
    const n = fieldName(f.name);
    if (pathParamNames.has(n)) {
      bodyFieldRenames.set(f.name, `body_${n}`);
    }
  }

  /** Resolve the Ruby kwarg name for a body field, applying renames if needed. */
  const bodyKwargName = (wireName: string): string => {
    return bodyFieldRenames.get(wireName) ?? fieldName(wireName);
  };

  // Method signature. Deduplicate param names across path/body/query.
  const sigParts: string[] = [];
  const seenParamNames = new Set<string>();

  // Path params: always required, snake_case.
  for (const p of pathParams) {
    const n = safeParamName(p.name);
    if (seenParamNames.has(n)) continue;
    seenParamNames.add(n);
    sigParts.push(`${n}:`);
  }

  // Required body/query params next.
  for (const f of bodyFields) {
    if (hiddenParams.has(f.name)) continue;
    if (!f.required) continue;
    const n = bodyKwargName(f.name);
    if (seenParamNames.has(n)) continue;
    seenParamNames.add(n);
    sigParts.push(`${n}:`);
  }
  for (const q of queryParams) {
    if (hiddenParams.has(q.name)) continue;
    if (!q.required) continue;
    const n = safeParamName(q.name);
    if (seenParamNames.has(n)) continue;
    seenParamNames.add(n);
    sigParts.push(`${n}:`);
  }

  // Required parameter group kwargs.
  for (const group of op.parameterGroups ?? []) {
    if (group.optional) continue;
    const n = fieldName(group.name);
    if (seenParamNames.has(n)) continue;
    seenParamNames.add(n);
    sigParts.push(`${n}:`);
  }

  // Optional body/query params.
  for (const f of bodyFields) {
    if (hiddenParams.has(f.name)) continue;
    if (f.required) continue;
    const n = bodyKwargName(f.name);
    if (seenParamNames.has(n)) continue;
    seenParamNames.add(n);
    sigParts.push(`${n}: nil`);
  }
  for (const q of queryParams) {
    if (hiddenParams.has(q.name)) continue;
    if (q.required) continue;
    const n = safeParamName(q.name);
    if (seenParamNames.has(n)) continue;
    seenParamNames.add(n);
    sigParts.push(`${n}: nil`);
  }

  // Optional parameter group kwargs.
  for (const group of op.parameterGroups ?? []) {
    if (!group.optional) continue;
    const n = fieldName(group.name);
    if (seenParamNames.has(n)) continue;
    seenParamNames.add(n);
    sigParts.push(`${n}: nil`);
  }

  // Always accept request_options.
  sigParts.push('request_options: {}');

  // YARD docs.
  const doc = buildYardDoc(op, pathParams, queryParams, bodyFields, hiddenParams, bodyFieldRenames, listWrapperModels);
  for (const line of doc) lines.push(`    ${line}`);

  // Signature.
  if (sigParts.length === 0) {
    lines.push(`    def ${method}`);
  } else if (sigParts.length === 1 && sigParts[0].length < 60) {
    lines.push(`    def ${method}(${sigParts[0]})`);
  } else {
    lines.push(`    def ${method}(`);
    for (let i = 0; i < sigParts.length; i++) {
      const sep = i === sigParts.length - 1 ? '' : ',';
      lines.push(`      ${sigParts[i]}${sep}`);
    }
    lines.push('    )');
  }

  // Emit deprecation warning for deprecated operations.
  if (op.deprecated) {
    lines.push(`      warn "[DEPRECATION] \\\`${method}\\\` is deprecated.", uplevel: 1`);
  }

  // Body: construct params / body / path
  const rubyPath = interpolateRubyPath(op.path, pathParams);

  // Query params hash
  const qEntries = queryParams.filter((q) => !hiddenParams.has(q.name));
  const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
  const hasQuery = qEntries.length > 0 || hasGroups;
  if (hasQuery) {
    lines.push('      params = {');
    for (let i = 0; i < qEntries.length; i++) {
      const q = qEntries[i];
      const sep = i === qEntries.length - 1 && !hasGroups ? '' : ',';
      lines.push(`        ${rubyStringLit(q.name)} => ${safeParamName(q.name)}${sep}`);
    }
    lines.push('      }.compact');

    // Parameter group dispatch: merge grouped params into the query hash
    for (const group of op.parameterGroups ?? []) {
      const prop = fieldName(group.name);
      if (group.optional) {
        lines.push(`      if ${prop}`);
        lines.push(`        case ${prop}[:type]`);
      } else {
        lines.push(`      case ${prop}[:type]`);
      }
      for (const variant of group.variants) {
        lines.push(`      when ${rubyStringLit(variant.name)}`);
        for (const p of variant.parameters) {
          lines.push(`        params[${rubyStringLit(p.name)}] = ${prop}[:${fieldName(p.name)}]`);
        }
      }
      lines.push('      end');
      if (group.optional) {
        lines.push('      end');
      }
    }
  }

  // Request body
  const method_http = op.httpMethod.toLowerCase();
  const hasBody = bodyFields.length > 0 && !['get', 'head'].includes(method_http);

  if (hasBody) {
    const bodyEntries: string[] = [];
    for (const [k, v] of Object.entries(defaults)) {
      const lit = typeof v === 'string' ? rubyStringLit(v) : String(v);
      bodyEntries.push(`${rubyStringLit(k)} => ${lit}`);
    }
    for (const fc of inferFromClient) {
      const clientProp = fc === 'client_secret' ? 'api_key' : fc;
      bodyEntries.push(`${rubyStringLit(fc)} => @client.${clientProp}`);
    }
    for (const f of bodyFields) {
      if (hiddenParams.has(f.name)) continue;
      bodyEntries.push(`${rubyStringLit(f.name)} => ${bodyKwargName(f.name)}`);
    }
    lines.push('      body = {');
    for (let i = 0; i < bodyEntries.length; i++) {
      const sep = i === bodyEntries.length - 1 ? '' : ',';
      lines.push(`        ${bodyEntries[i]}${sep}`);
    }
    lines.push('      }.compact');
  }

  // Make the request
  const verb = httpVerbRubyMethod(method_http);
  const extras: string[] = [];
  extras.push(`path: ${rubyPath}`);
  extras.push('auth: true');
  if (hasQuery) extras.push('params: params');
  if (hasBody) extras.push('body: body');

  lines.push('      response = @client.execute_request(');
  lines.push(`        request: @client.${verb}(${extras.join(', ')}, request_options: request_options),`);
  lines.push('        request_options: request_options');
  lines.push('      )');

  // Response handling
  void plan;
  // Build the list of local kwarg names that should be forwarded when the
  // method recursively calls itself for the next page (excluding the cursor
  // param, which is overridden).
  const forwardableParams: string[] = [];
  const bodyNames = new Set(bodyFields.map((f) => bodyKwargName(f.name)));
  for (const p of pathParams) forwardableParams.push(safeParamName(p.name));
  for (const f of bodyFields) {
    if (hiddenParams.has(f.name)) continue;
    forwardableParams.push(bodyKwargName(f.name));
  }
  for (const q of queryParams) {
    if (hiddenParams.has(q.name)) continue;
    const name = safeParamName(q.name);
    if (bodyNames.has(name) || forwardableParams.includes(name)) continue;
    forwardableParams.push(name);
  }
  // Include parameter group kwargs so they are forwarded in pagination fetch_next.
  for (const group of op.parameterGroups ?? []) {
    const name = fieldName(group.name);
    if (!forwardableParams.includes(name)) {
      forwardableParams.push(name);
    }
  }
  const responseLines = emitResponseHandling(op, listWrapperModels, modelNames, method, forwardableParams);
  for (const line of responseLines) lines.push(`      ${line}`);

  lines.push('    end');

  // Ensure we require the response model file if needed.
  // Skip list-wrapper models (they are not emitted as files).
  const respModel = findPrimaryResponseModel(op.response);
  if (respModel && modelNames.has(respModel) && !listWrapperModels.has(respModel)) {
    requires.add(fileName(respModel));
  }

  return lines.join('\n');
}

/** Build the response parsing expression(s). */
function emitResponseHandling(
  op: Operation,
  listWrapperModels: Map<string, Model>,
  modelNames: Set<string>,
  currentMethod: string,
  forwardableParams: string[],
): string[] {
  const ref = op.response;

  // Build a filters hash from the forwarded params (excluding cursor).
  const filterEntries = forwardableParams
    .filter((p) => p !== 'after' && p !== 'request_options')
    .map((p) => `${p}: ${p}`)
    .join(', ');
  const filtersArg = filterEntries ? `, filters: { ${filterEntries} }` : '';

  // Pagination / list wrapper: unwrap and return ListStruct with auto-paging wired.
  if (ref.kind === 'model' && listWrapperModels.has(ref.name)) {
    const wrapper = listWrapperModels.get(ref.name)!;
    const dataField = wrapper.fields.find((f) => f.name === 'data');
    const itemCls =
      dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model'
        ? `WorkOS::${className(dataField.type.items.name)}`
        : null;

    // fetch_next always uses "after" for forward pagination regardless of
    // op.pagination.param (which may be "before" in some IR representations).
    const cursorLocal = safeParamName('after');
    const hasCursorInSignature = forwardableParams.includes(cursorLocal);

    const out: string[] = [];
    out.push(`parsed = JSON.parse(response.body)`);
    if (itemCls) {
      out.push(`items = (parsed['data'] || []).map { |item| ${itemCls}.new(item) }`);
    } else {
      out.push(`items = parsed['data'] || []`);
    }

    if (hasCursorInSignature) {
      // Capture current kwargs into a lambda that overrides the cursor param and
      // forwards everything else (including request_options).
      out.push(`fetch_next = lambda do |metadata|`);
      out.push(`  cursor = metadata.is_a?(Hash) ? (metadata['after'] || metadata[:after]) : nil`);
      out.push(`  return nil if cursor.nil? || cursor.to_s.empty?`);
      out.push(`  ${currentMethod}(`);
      const allForwards = [...forwardableParams, 'request_options'];
      for (let i = 0; i < allForwards.length; i++) {
        const param = allForwards[i];
        const sep = i === allForwards.length - 1 ? '' : ',';
        const value = param === cursorLocal ? 'cursor' : param;
        out.push(`    ${param}: ${value}${sep}`);
      }
      out.push(`  )`);
      out.push(`end`);
      out.push(
        `WorkOS::Types::ListStruct.new(data: items, list_metadata: parsed['list_metadata'], fetch_next: fetch_next${filtersArg})`,
      );
    } else {
      out.push(`WorkOS::Types::ListStruct.new(data: items, list_metadata: parsed['list_metadata']${filtersArg})`);
    }
    return out;
  }

  if (ref.kind === 'model' && modelNames.has(ref.name)) {
    return [`WorkOS::${className(ref.name)}.new(response.body)`];
  }

  // Paginated endpoint whose IR response is typed as array (the IR lost the
  // wrapper envelope). When op.pagination exists, the real HTTP response is
  // { data: [...], list_metadata: {...} } — generate ListStruct handling.
  if (ref.kind === 'array' && op.pagination) {
    const itemCls =
      ref.items.kind === 'model' && modelNames.has(ref.items.name) ? `WorkOS::${className(ref.items.name)}` : null;

    const cursorLocal = safeParamName('after');
    const hasCursorInSignature = forwardableParams.includes(cursorLocal);

    const out: string[] = [];
    out.push(`parsed = JSON.parse(response.body)`);
    if (itemCls) {
      out.push(`items = (parsed['data'] || []).map { |item| ${itemCls}.new(item) }`);
    } else {
      out.push(`items = parsed['data'] || []`);
    }

    if (hasCursorInSignature) {
      out.push(`fetch_next = lambda do |metadata|`);
      out.push(`  cursor = metadata.is_a?(Hash) ? (metadata['after'] || metadata[:after]) : nil`);
      out.push(`  return nil if cursor.nil? || cursor.to_s.empty?`);
      out.push(`  ${currentMethod}(`);
      const allForwards = [...forwardableParams, 'request_options'];
      for (let i = 0; i < allForwards.length; i++) {
        const param = allForwards[i];
        const sep = i === allForwards.length - 1 ? '' : ',';
        const value = param === cursorLocal ? 'cursor' : param;
        out.push(`    ${param}: ${value}${sep}`);
      }
      out.push(`  )`);
      out.push(`end`);
      out.push(
        `WorkOS::Types::ListStruct.new(data: items, list_metadata: parsed['list_metadata'], fetch_next: fetch_next${filtersArg})`,
      );
    } else {
      out.push(`WorkOS::Types::ListStruct.new(data: items, list_metadata: parsed['list_metadata']${filtersArg})`);
    }
    return out;
  }

  if (ref.kind === 'array' && ref.items.kind === 'model' && modelNames.has(ref.items.name)) {
    const itemCls = `WorkOS::${className(ref.items.name)}`;
    return [`parsed = JSON.parse(response.body)`, `(parsed || []).map { |item| ${itemCls}.new(item) }`];
  }

  if (ref.kind === 'nullable') {
    return emitResponseHandling(
      { ...op, response: ref.inner },
      listWrapperModels,
      modelNames,
      currentMethod,
      forwardableParams,
    );
  }

  // Unknown/void response — return nil
  if (ref.kind === 'primitive' && ref.type === 'unknown') {
    return ['nil'];
  }

  // Default: return parsed JSON
  return [`JSON.parse(response.body)`];
}

/** Find the primary model name (if any) in a response TypeRef. */
function findPrimaryResponseModel(ref: TypeRef): string | null {
  switch (ref.kind) {
    case 'model':
      return ref.name;
    case 'nullable':
      return findPrimaryResponseModel(ref.inner);
    case 'array':
      return findPrimaryResponseModel(ref.items);
    case 'union': {
      for (const v of ref.variants) {
        const n = findPrimaryResponseModel(v);
        if (n) return n;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Get the body fields, expanded from model refs. Handles nested/model refs and unions. */
function getRequestBodyFields(
  op: Operation,
  hiddenParams: Set<string>,
  modelByName: Map<string, Model>,
): { name: string; required: boolean; type: TypeRef; description?: string; deprecated?: boolean }[] {
  void hiddenParams;
  const ref = op.requestBody;
  if (!ref) return [];

  if (ref.kind === 'model') {
    const model = modelByName.get(ref.name);
    if (!model) return [];
    return model.fields.map((f) => ({
      name: f.name,
      required: f.required,
      type: f.type,
      description: f.description,
      deprecated: f.deprecated,
    }));
  }
  if (ref.kind === 'nullable') {
    return getRequestBodyFields({ ...op, requestBody: ref.inner }, hiddenParams, modelByName);
  }
  // Unions: merge fields from ALL model variants so every possible body param
  // is exposed. Fields that appear in every variant keep their original
  // requiredness; fields that appear in only some variants become optional.
  if (ref.kind === 'union') {
    const variantFieldSets: Map<
      string,
      { name: string; required: boolean; type: TypeRef; description?: string; deprecated?: boolean }
    >[] = [];
    for (const v of ref.variants) {
      if (v.kind === 'model') {
        const model = modelByName.get(v.name);
        if (model) {
          const fieldMap = new Map<
            string,
            { name: string; required: boolean; type: TypeRef; description?: string; deprecated?: boolean }
          >();
          for (const f of model.fields) {
            fieldMap.set(f.name, {
              name: f.name,
              required: f.required,
              type: f.type,
              description: f.description,
              deprecated: f.deprecated,
            });
          }
          variantFieldSets.push(fieldMap);
        }
      }
    }
    if (variantFieldSets.length === 0) return [];

    // Collect all field names in order (preserving first-seen order).
    const allFieldNames: string[] = [];
    const seen = new Set<string>();
    for (const fieldMap of variantFieldSets) {
      for (const name of fieldMap.keys()) {
        if (!seen.has(name)) {
          seen.add(name);
          allFieldNames.push(name);
        }
      }
    }

    return allFieldNames.map((name) => {
      // Use the first variant that has this field as the canonical source.
      const canonical = variantFieldSets.find((fm) => fm.has(name))!.get(name)!;
      // A field is required only if it appears and is required in EVERY variant.
      const requiredInAll = variantFieldSets.every((fm) => {
        const f = fm.get(name);
        return f && f.required;
      });
      return { ...canonical, required: requiredInAll };
    });
  }
  return [];
}

/** Convert an OpenAPI path like /orgs/{id}/users/{uid} to a Ruby interpolated string. */
function interpolateRubyPath(path: string, pathParams: Parameter[]): string {
  if (pathParams.length === 0) {
    return `'${path}'`;
  }
  let result = path;
  for (const p of pathParams) {
    const placeholder = `{${p.name}}`;
    result = result.split(placeholder).join(`#{${safeParamName(p.name)}}`);
  }
  return `"${result}"`;
}

/** Map HTTP verb to the client method name (get_request, post_request, ...). */
function httpVerbRubyMethod(method: string): string {
  const m = method.toLowerCase();
  switch (m) {
    case 'get':
      return 'get_request';
    case 'post':
      return 'post_request';
    case 'put':
      return 'put_request';
    case 'patch':
      return 'patch_request';
    case 'delete':
      return 'delete_request';
    default:
      return 'get_request';
  }
}

/** Collapse multi-line description text into a single YARD-safe line. */
function oneLine(desc: string | undefined): string {
  if (!desc) return '';
  return desc.replace(/\r/g, ' ').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildYardDoc(
  op: Operation,
  pathParams: Parameter[],
  queryParams: Parameter[],
  bodyFields: { name: string; required: boolean; type: TypeRef; description?: string; deprecated?: boolean }[],
  hiddenParams: Set<string>,
  bodyFieldRenames?: Map<string, string>,
  listWrapperModels?: Map<string, Model>,
): string[] {
  const lines: string[] = [];
  const summary = op.description ?? `${op.httpMethod.toUpperCase()} ${op.path}`;
  const firstLine = summary.split('\n')[0] ?? '';
  lines.push(`# ${firstLine}`);
  if (op.deprecated) {
    lines.push('# @deprecated');
  }

  // Track emitted param names to avoid duplicates (e.g. code in both body and query).
  const emittedParamNames = new Set<string>();

  for (const p of pathParams) {
    const n = safeParamName(p.name);
    if (emittedParamNames.has(n)) continue;
    emittedParamNames.add(n);
    const type = mapTypeRefForYard(p.type);
    const deprecatedPrefix = p.deprecated ? '(deprecated) ' : '';
    lines.push(`# @param ${n} [${type}] ${deprecatedPrefix}${oneLine(p.description)}`.trim());
  }
  for (const f of bodyFields) {
    if (hiddenParams.has(f.name)) continue;
    const paramName = bodyFieldRenames?.get(f.name) ?? fieldName(f.name);
    if (emittedParamNames.has(paramName)) continue;
    emittedParamNames.add(paramName);
    const type = mapTypeRefForYard(f.type);
    // Only append nil suffix for optional params whose type doesn't already include nil.
    const alreadyNilable = type.split(', ').includes('nil');
    const suffix = f.required || alreadyNilable ? '' : ', nil';
    const deprecatedPrefix = f.deprecated ? '(deprecated) ' : '';
    lines.push(`# @param ${paramName} [${type}${suffix}] ${deprecatedPrefix}${oneLine(f.description)}`.trim());
  }
  for (const q of queryParams) {
    if (hiddenParams.has(q.name)) continue;
    const n = safeParamName(q.name);
    if (emittedParamNames.has(n)) continue;
    emittedParamNames.add(n);
    const type = mapTypeRefForYard(q.type);
    const alreadyNilable = type.split(', ').includes('nil');
    const suffix = q.required || alreadyNilable ? '' : ', nil';
    const deprecatedPrefix = q.deprecated ? '(deprecated) ' : '';
    lines.push(`# @param ${n} [${type}${suffix}] ${deprecatedPrefix}${oneLine(q.description)}`.trim());
  }
  lines.push(
    `# @param request_options [Hash] Per-request overrides: :api_key, :timeout, :base_url, :max_retries, :idempotency_key, :extra_headers.`,
  );

  // Return type: void for unknown-primitive, ListStruct for list wrappers and
  // paginated array endpoints.
  const ref = op.response;
  if (ref.kind === 'primitive' && ref.type === 'unknown') {
    lines.push(`# @return [void]`);
  } else if (ref.kind === 'model' && listWrapperModels?.has(ref.name)) {
    lines.push(`# @return [WorkOS::Types::ListStruct]`);
  } else if (ref.kind === 'array' && op.pagination) {
    lines.push(`# @return [WorkOS::Types::ListStruct]`);
  } else {
    const retType = mapTypeRefForYard(ref);
    lines.push(`# @return [${retType}]`);
  }
  return lines;
}

void methodName;

/** Render a Ruby single-quoted string literal, escaping embedded quotes and backslashes. */
function rubyStringLit(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

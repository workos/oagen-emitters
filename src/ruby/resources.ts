import type { Service, EmitterContext, GeneratedFile, Operation, TypeRef, Parameter, Model } from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import {
  className,
  fieldName,
  fileName,
  methodName,
  safeParamName,
  resolveMethodName,
  scopedGroupVariantClassName,
} from './naming.js';
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
import { buildGroupOwnerMap, collectVariantsForMountTarget, emitInlineVariantClass } from './parameter-groups.js';

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

  // Resolve groupName -> owner mountTarget once per generation pass; every
  // dispatcher and YARD `@param` reference resolves variant classes through
  // this map so cross-resource references stay consistent.
  const groupOwners = buildGroupOwnerMap(ctx);

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
        groupOwners,
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

    // Inline parameter-group variant classes owned by this mount target.
    // Zeitwerk's `loader.collapse` flattens `lib/workos/<service>/` so files
    // there can't define `WorkOS::<Service>::*` constants — variants must
    // live inside the service's own file. Matches Python's per-resource
    // dataclass layout.
    const variants = collectVariantsForMountTarget(ctx, ctx.spec.models as Model[], mountTarget);
    for (const v of variants) {
      for (const line of emitInlineVariantClass(v)) lines.push(line);
      lines.push('');
    }

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
  groupOwners: Map<string, string>;
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
    groupOwners,
  } = args;
  void enumNames;

  /** Fully-qualified Ruby constant for a variant (e.g. WorkOS::UserManagement::PasswordPlaintext). */
  const variantClassRef = (group: { name: string }, variantName: string): string => {
    const owner = groupOwners.get(group.name);
    if (!owner) {
      throw new Error(`No owner mount target found for parameter group '${group.name}'`);
    }
    return scopedGroupVariantClassName(owner, group.name, variantName);
  };

  const plan = planOperation(op);
  const lines: string[] = [];

  // Collect params: path params positional, others keyword.
  const pathParams = op.pathParams ?? [];
  const groupedParamNames = collectGroupedParamNames(op);
  const queryParams = (op.queryParams ?? []).filter((q) => !groupedParamNames.has(q.name));

  // Request body params: if body is a model, expand its fields. Drop any field
  // whose name is also a parameter-group name — those are dispatched by the
  // group kwarg below, so emitting them as flat kwargs would shadow the group
  // and cause `String#[Symbol]` TypeErrors when the dispatcher reads `:type`.
  const bodyFields = getRequestBodyFields(op, hiddenParams, modelByName).filter((f) => !groupedParamNames.has(f.name));

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
    const defaultVal = q.name === 'order' ? rubyStringLit('desc') : 'nil';
    sigParts.push(`${n}: ${defaultVal}`);
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
  const doc = buildYardDoc(
    op,
    pathParams,
    queryParams,
    bodyFields,
    hiddenParams,
    bodyFieldRenames,
    listWrapperModels,
    variantClassRef,
  );
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

  // Query params hash.
  // For methods with a request body (POST/PUT/PATCH), exclude query params
  // that also appear as body fields — they belong in the body only.
  const method_http = op.httpMethod.toLowerCase();
  const hasBodyMethod = !['get', 'head', 'delete'].includes(method_http);
  const bodyFieldNameSet = new Set(bodyFields.map((f) => f.name));
  const qEntries = queryParams.filter(
    (q) => !hiddenParams.has(q.name) && !(hasBodyMethod && bodyFieldNameSet.has(q.name)),
  );
  const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
  // Groups go to query only for operations without a request body (GET/DELETE).
  // For POST/PUT/PATCH, groups are dispatched into the body below.
  const groupsGoToQuery = hasGroups && !hasBodyMethod;
  const hasQuery = qEntries.length > 0 || groupsGoToQuery;
  if (hasQuery) {
    // Skip `.compact` when no entry can be nil — required kwargs are always
    // passed (Ruby raises ArgumentError otherwise), so the literal has no nil
    // values to drop. Group dispatch happens after the literal is built and
    // doesn't contribute potentially-nil entries either.
    const queryHasNilable = qEntries.some((q) => !q.required);
    const queryCompact = queryHasNilable ? '.compact' : '';
    lines.push('      params = {');
    for (let i = 0; i < qEntries.length; i++) {
      const q = qEntries[i];
      const sep = i === qEntries.length - 1 && !groupsGoToQuery ? '' : ',';
      lines.push(`        ${rubyStringLit(q.name)} => ${safeParamName(q.name)}${sep}`);
    }
    lines.push(`      }${queryCompact}`);

    if (groupsGoToQuery) {
      // Parameter group dispatch: callers pass a typed variant class instance
      // (e.g. `WorkOS::ParentResourceById`); we pattern-match on its class
      // and forward its readers into the query hash.
      for (const group of op.parameterGroups ?? []) {
        const prop = fieldName(group.name);
        if (group.optional) {
          lines.push(`      if ${prop}`);
          lines.push(`        case ${prop}`);
        } else {
          lines.push(`      case ${prop}`);
        }
        for (const variant of group.variants) {
          const variantClass = variantClassRef(group, variant.name);
          lines.push(`      when ${variantClass}`);
          for (const p of variant.parameters) {
            lines.push(`        params[${rubyStringLit(p.name)}] = ${prop}.${fieldName(p.name)}`);
          }
        }
        lines.push(`      else`);
        lines.push(`        raise ArgumentError, ${dispatchErrorLiteral(group, prop, variantClassRef)}`);
        lines.push('      end');
        if (group.optional) {
          lines.push('      end');
        }
      }
    }
  }

  // Request body. Emit when there are non-group body fields OR a parameter
  // group dispatches into the body — the latter case matters when an
  // operation's body is exclusively managed by a group (e.g.
  // update_organization_membership's `role`), where filtering the group's
  // leaves leaves bodyFields empty but the request still needs a payload.
  const hasBody = (bodyFields.length > 0 && !['get', 'head'].includes(method_http)) || (hasGroups && hasBodyMethod);

  if (hasBody) {
    const bodyEntries: string[] = [];
    for (const [k, v] of Object.entries(defaults)) {
      const lit = typeof v === 'string' ? rubyStringLit(v) : String(v);
      bodyEntries.push(`${rubyStringLit(k)} => ${lit}`);
    }
    for (const fc of inferFromClient) {
      const clientProp = fc === 'client_secret' ? 'api_key' : fc;
      const optKey = fc === 'client_secret' ? 'api_key' : fc;
      bodyEntries.push(`${rubyStringLit(fc)} => (request_options[:${optKey}] || @client.${clientProp})`);
    }
    // Track whether any literal entry can be nil — defaults/inferFromClient
    // resolve to non-nil values, so only optional body kwargs are nilable.
    let bodyHasNilable = false;
    for (const f of bodyFields) {
      if (hiddenParams.has(f.name)) continue;
      bodyEntries.push(`${rubyStringLit(f.name)} => ${bodyKwargName(f.name)}`);
      if (!f.required) bodyHasNilable = true;
    }
    const bodyCompact = bodyHasNilable ? '.compact' : '';
    lines.push('      body = {');
    for (let i = 0; i < bodyEntries.length; i++) {
      const sep = i === bodyEntries.length - 1 ? '' : ',';
      lines.push(`        ${bodyEntries[i]}${sep}`);
    }
    lines.push(`      }${bodyCompact}`);

    // Parameter group dispatch into body for POST/PUT/PATCH so sensitive
    // fields (passwords, role slugs) never leak into the URL query string.
    // DELETE groups are already handled via query above (groupsGoToQuery).
    // Callers pass a typed variant class instance and we pattern-match on it.
    if (hasGroups && hasBodyMethod) {
      for (const group of op.parameterGroups ?? []) {
        const prop = fieldName(group.name);
        if (group.optional) {
          lines.push(`      if ${prop}`);
          lines.push(`        case ${prop}`);
        } else {
          lines.push(`      case ${prop}`);
        }
        for (const variant of group.variants) {
          const variantClass = variantClassRef(group, variant.name);
          lines.push(`      when ${variantClass}`);
          for (const p of variant.parameters) {
            lines.push(`        body[${rubyStringLit(p.name)}] = ${prop}.${fieldName(p.name)}`);
          }
        }
        lines.push(`      else`);
        lines.push(`        raise ArgumentError, ${dispatchErrorLiteral(group, prop, variantClassRef)}`);
        lines.push('      end');
        if (group.optional) {
          lines.push('      end');
        }
      }
    }
  }

  // Make the request via the unified @client.request helper.
  const requestArgs: string[] = [];
  requestArgs.push(`method: :${method_http}`);
  requestArgs.push(`path: ${rubyPath}`);
  requestArgs.push('auth: true');
  if (hasQuery) requestArgs.push('params: params');
  if (hasBody) requestArgs.push('body: body');
  requestArgs.push('request_options: request_options');

  lines.push('      response = @client.request(');
  for (let i = 0; i < requestArgs.length; i++) {
    const sep = i === requestArgs.length - 1 ? '' : ',';
    lines.push(`        ${requestArgs[i]}${sep}`);
  }
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
  const _filtersArg = filterEntries ? `, filters: { ${filterEntries} }` : '';

  // Pagination / list wrapper: use ListStruct.from_response with auto-paging wired.
  if (ref.kind === 'model' && listWrapperModels.has(ref.name)) {
    const wrapper = listWrapperModels.get(ref.name)!;
    const dataField = wrapper.fields.find((f) => f.name === 'data');
    const itemCls =
      dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model'
        ? `WorkOS::${className(dataField.type.items.name)}`
        : null;

    const cursorLocal = safeParamName('after');
    const hasCursorInSignature = forwardableParams.includes(cursorLocal);

    const out: string[] = [];

    if (hasCursorInSignature) {
      // Build a fetch_next lambda that accepts a cursor string and replays
      // the current call with the new cursor.
      out.push(`fetch_next = ->(cursor) {`);
      out.push(`  ${currentMethod}(`);
      const allForwards = [...forwardableParams, 'request_options'];
      for (let i = 0; i < allForwards.length; i++) {
        const param = allForwards[i];
        const sep = i === allForwards.length - 1 ? '' : ',';
        const value = param === cursorLocal ? 'cursor' : param;
        out.push(`    ${param}: ${value}${sep}`);
      }
      out.push(`  )`);
      out.push(`}`);
    }

    const fromArgs: string[] = [];
    fromArgs.push('response');
    if (itemCls) fromArgs.push(`model: ${itemCls}`);
    if (filterEntries) fromArgs.push(`filters: { ${filterEntries} }`);
    if (hasCursorInSignature) fromArgs.push('fetch_next: fetch_next');

    if (fromArgs.length <= 2) {
      out.push(`WorkOS::Types::ListStruct.from_response(${fromArgs.join(', ')})`);
    } else {
      out.push(`WorkOS::Types::ListStruct.from_response(`);
      for (let i = 0; i < fromArgs.length; i++) {
        const sep = i === fromArgs.length - 1 ? '' : ',';
        out.push(`  ${fromArgs[i]}${sep}`);
      }
      out.push(`)`);
    }
    return out;
  }

  if (ref.kind === 'model' && modelNames.has(ref.name)) {
    const cls = `WorkOS::${className(ref.name)}`;
    return [
      `result = ${cls}.new(response.body)`,
      `result.last_response = WorkOS::Types::ApiResponse.new(http_status: response.code.to_i, http_headers: response.each_header.to_h, request_id: response["x-request-id"])`,
      `result`,
    ];
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

    if (hasCursorInSignature) {
      out.push(`fetch_next = ->(cursor) {`);
      out.push(`  ${currentMethod}(`);
      const allForwards = [...forwardableParams, 'request_options'];
      for (let i = 0; i < allForwards.length; i++) {
        const param = allForwards[i];
        const sep = i === allForwards.length - 1 ? '' : ',';
        const value = param === cursorLocal ? 'cursor' : param;
        out.push(`    ${param}: ${value}${sep}`);
      }
      out.push(`  )`);
      out.push(`}`);
    }

    const fromArgs: string[] = [];
    fromArgs.push('response');
    if (itemCls) fromArgs.push(`model: ${itemCls}`);
    if (filterEntries) fromArgs.push(`filters: { ${filterEntries} }`);
    if (hasCursorInSignature) fromArgs.push('fetch_next: fetch_next');

    if (fromArgs.length <= 2) {
      out.push(`WorkOS::Types::ListStruct.from_response(${fromArgs.join(', ')})`);
    } else {
      out.push(`WorkOS::Types::ListStruct.from_response(`);
      for (let i = 0; i < fromArgs.length; i++) {
        const sep = i === fromArgs.length - 1 ? '' : ',';
        out.push(`  ${fromArgs[i]}${sep}`);
      }
      out.push(`)`);
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
    result = result.split(placeholder).join(`#{WorkOS::Util.encode_path(${safeParamName(p.name)})}`);
  }
  return `"${result}"`;
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
  bodyFieldRenames: Map<string, string> | undefined,
  listWrapperModels: Map<string, Model> | undefined,
  variantClassRef: (group: { name: string }, variantName: string) => string,
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
  // Parameter group kwargs: the type bracket lists the variant classes the
  // caller may pass; no extra prose needed since YARD already renders them.
  for (const group of op.parameterGroups ?? []) {
    const n = fieldName(group.name);
    if (emittedParamNames.has(n)) continue;
    emittedParamNames.add(n);
    const variantTypes = group.variants.map((v) => variantClassRef(group, v.name)).join(', ');
    const suffix = group.optional ? ', nil' : '';
    lines.push(`# @param ${n} [${variantTypes}${suffix}] Identifies the ${group.name.replace(/_/g, ' ')}.`);
  }
  lines.push(`# @param request_options [Hash] (see WorkOS::Types::RequestOptions)`);

  // Return type: void for unknown-primitive, ListStruct for list wrappers and
  // paginated array endpoints (with element type annotation).
  const ref = op.response;
  if (ref.kind === 'primitive' && ref.type === 'unknown') {
    lines.push(`# @return [void]`);
  } else if (ref.kind === 'model' && listWrapperModels?.has(ref.name)) {
    const wrapper = listWrapperModels.get(ref.name)!;
    const dataField = wrapper.fields.find((f: { name: string; type: TypeRef }) => f.name === 'data');
    const elementType =
      dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model'
        ? `WorkOS::${className(dataField.type.items.name)}`
        : null;
    const suffix = elementType ? `<${elementType}>` : '';
    lines.push(`# @return [WorkOS::Types::ListStruct${suffix}]`);
  } else if (ref.kind === 'array' && op.pagination) {
    const elementType = ref.items.kind === 'model' ? `WorkOS::${className(ref.items.name)}` : null;
    const suffix = elementType ? `<${elementType}>` : '';
    lines.push(`# @return [WorkOS::Types::ListStruct${suffix}]`);
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

/**
 * Build a Ruby double-quoted string expression for the `else raise ArgumentError`
 * arm of a parameter-group dispatcher. Lists the expected variant classes and
 * interpolates the actual class of the value the caller passed.
 */
function dispatchErrorLiteral(
  group: { name: string; variants: { name: string }[] },
  prop: string,
  variantClassRef: (group: { name: string }, variantName: string) => string,
): string {
  const expected = group.variants.map((v) => variantClassRef(group, v.name)).join(', ');
  return `"expected ${prop} to be one of: ${expected}, got #{${prop}.class}"`;
}

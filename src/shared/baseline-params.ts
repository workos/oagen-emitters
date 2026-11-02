import type { ApiParam } from '@workos/oagen/compat';

/** A rendered method parameter: its bare name and whether callers may omit it. */
export interface BaselineOrderedParam {
  name: string;
  optional: boolean;
}

export interface PreserveParameterOrderOptions<T extends BaselineOrderedParam> {
  /** Emitter name for the warning prefix, e.g. `php`. */
  language: string;
  /** `Class.method`, named in the warning. */
  label: string;
  /** How the warning spells a parameter (`$userId` in PHP). Defaults to the bare name. */
  displayName?: (name: string) => string;
  /**
   * Re-declare a parameter the baseline had required so it stays required
   * even though the schema now lets callers omit it: a new default must not
   * move the slots after it. Defaults to leaving the parameter as rendered.
   */
  makeRequired?: (param: T) => T;
  /**
   * Whether the language lets a required parameter follow a defaulted one
   * (Kotlin does, PHP deprecates it). When false, a newly required parameter,
   * or a baseline-optional one the schema made required, makes the method
   * fall back to the schema signature with a warning. When true, the slot is
   * kept and newly required parameters go after every baseline parameter, so
   * an old positional call fails to compile instead of binding the wrong value.
   */
  allowRequiredAfterOptional?: boolean;
}

/**
 * Keep the baseline's parameter names and positions and append every newer
 * parameter after them, in schema order. The baseline is the method's
 * signature in the SDK as shipped (`ctx.apiSurface`), so a positional call
 * written against it keeps its meaning across regenerations.
 *
 * A method whose baseline the current contract can no longer honor (a
 * parameter removed, or a requiredness change the language cannot express in
 * place) is emitted from the schema instead: a signature the API rejects is
 * not worth preserving, so the correct one wins and the warning names the
 * break. `pinned` says whether the baseline order was applied.
 */
export function preserveParameterOrder<T extends BaselineOrderedParam>(
  params: readonly T[],
  baseline: readonly ApiParam[] | undefined,
  options: PreserveParameterOrderOptions<T>,
): { params: T[]; pinned: boolean } {
  if (!baseline) return { params: [...params], pinned: false };
  const show = options.displayName ?? ((name: string) => name);
  const regenerate = (reason: string): { params: T[]; pinned: boolean } => {
    console.warn(
      `[oagen] ${options.language}: ${options.label}: ${reason}; emitting the schema signature instead of the baseline`,
    );
    return { params: [...params], pinned: false };
  };
  const byName = new Map(params.map((param) => [param.name, param]));
  const ordered: T[] = [];
  for (const previous of baseline) {
    const param = byName.get(previous.name);
    if (!param) return regenerate(`baseline parameter ${show(previous.name)} was removed`);
    if (previous.optional && !param.optional && !options.allowRequiredAfterOptional) {
      return regenerate(`baseline parameter ${show(previous.name)} became required`);
    }
    ordered.push(!previous.optional && options.makeRequired ? options.makeRequired(param) : param);
    byName.delete(previous.name);
  }
  for (const [name, param] of byName) {
    if (!param.optional && !options.allowRequiredAfterOptional) {
      return regenerate(`new parameter ${show(name)} is required`);
    }
    ordered.push(param);
  }
  return { params: ordered, pinned: true };
}

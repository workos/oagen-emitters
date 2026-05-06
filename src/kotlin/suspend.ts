/**
 * Helpers for emitting `suspend` overloads alongside every generated
 * blocking SDK method. The suspend variant simply delegates to the blocking
 * implementation under `withContext(Dispatchers.IO)`, so callers can invoke
 * any operation from a coroutine context without blocking the calling
 * dispatcher.
 *
 * Naming: the suspend variant uses a `Suspend`-suffixed Kotlin source name
 * (e.g. `deleteEndpointSuspend`). This matters because Kotlin does not let
 * a `suspend` function and a non-`suspend` function with the same name and
 * identical value parameters coexist in the same scope — they are not
 * distinguishable at call sites, even with `@JvmName`. (`@JvmName` only
 * disambiguates JVM signatures, not Kotlin source names.) Naming the suspend
 * variant explicitly sidesteps the conflict and makes the choice between
 * blocking and suspending callable obvious at the call site. The matching
 * `@JvmName("...Suspend")` is now technically redundant but kept for
 * explicit clarity in Java interop / tooling.
 */

import { escapeReserved } from './naming.js';

export interface SuspendParam {
  /** Already-rendered "name: Type" or "name: Type = default" Kotlin declaration. */
  decl: string;
  /** Bare parameter name to forward to the blocking version. */
  name: string;
}

/**
 * Emit a suspend overload that delegates to a blocking method.
 *
 * The emitted lines preserve the parameter declarations (including default
 * values) so callers can invoke the suspend variant with named arguments and
 * skip optional parameters, just as they do with the blocking version.
 *
 * The emitted suspend method is named `${methodName}Suspend` (a distinct
 * Kotlin source name from the blocking method) — see the file-level KDoc for
 * why this is required.
 */
export function emitSuspendVariant(opts: {
  methodName: string;
  params: SuspendParam[];
  returnType: string;
  deprecated?: boolean;
}): string[] {
  const { methodName, params, returnType, deprecated } = opts;
  const suspendName = `${methodName}Suspend`;
  const lines: string[] = [];

  lines.push('  /**');
  lines.push(`   * Coroutine-aware variant of [${escapeReserved(methodName)}]. Use this from`);
  lines.push('   * a `suspend` function or coroutine scope.');
  lines.push('   *');
  lines.push(`   * Delegates to the blocking [${escapeReserved(methodName)}] under`);
  lines.push('   * `withContext(Dispatchers.IO)`, so this is safe to call from any');
  lines.push('   * coroutine dispatcher (including `Dispatchers.Main`).');
  lines.push('   */');
  if (deprecated) lines.push('  @Deprecated("Deprecated operation")');
  lines.push(`  @JvmName(${jvmNameLiteral(suspendName)})`);

  const returnClause = returnType === 'Unit' ? '' : `: ${returnType}`;
  const callArgs = params.map((p) => p.name).join(', ');

  if (params.length === 0) {
    lines.push(`  suspend fun ${escapeReserved(suspendName)}()${returnClause} = withContext(Dispatchers.IO) {`);
    lines.push(`    ${escapeReserved(methodName)}()`);
    lines.push('  }');
    return lines;
  }

  if (params.length === 1) {
    const single = params[0].decl.replace(/^\s+/, '');
    lines.push(
      `  suspend fun ${escapeReserved(suspendName)}(${single})${returnClause} = withContext(Dispatchers.IO) {`,
    );
  } else {
    lines.push(`  suspend fun ${escapeReserved(suspendName)}(`);
    for (let i = 0; i < params.length; i++) {
      const suffix = i === params.length - 1 ? '' : ',';
      lines.push(`${params[i].decl}${suffix}`);
    }
    lines.push(`  )${returnClause} = withContext(Dispatchers.IO) {`);
  }
  lines.push(`    ${escapeReserved(methodName)}(${callArgs})`);
  lines.push('  }');
  return lines;
}

/**
 * Imports a service file needs to declare any suspend overloads.
 */
export const SUSPEND_IMPORTS: readonly string[] = ['kotlinx.coroutines.Dispatchers', 'kotlinx.coroutines.withContext'];

function jvmNameLiteral(name: string): string {
  return JSON.stringify(name);
}

import type { GeneratedFile } from '@workos/oagen';

/**
 * PHP exception classes are now hand-maintained in the target SDK
 * (lib/Exception/*.php with @oagen-ignore-file).
 */
export function generateErrors(): GeneratedFile[] {
  return [];
}

import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate PHP configuration and shared type files.
 * For PHP, the main config is handled by the client constructor.
 * This generates any additional shared utilities.
 */
export function generateConfig(_ctx?: EmitterContext): GeneratedFile[] {
  // PHP config is handled by the client constructor and RequestOptions.
  // No additional config files needed beyond what client.ts generates.
  return [];
}

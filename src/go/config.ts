import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate Go configuration.
 * Config is handled inline by the client constructor (NewClient + ClientOption).
 * No separate config file needed in Go's flat package.
 */
export function generateConfig(_ctx: EmitterContext): GeneratedFile[] {
  return [];
}

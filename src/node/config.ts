import type { GeneratedFile } from "@workos/oagen";

export function generateConfig(): GeneratedFile[] {
  return [
    {
      path: "src/common/interfaces/workos-options.interface.ts",
      content: `export interface WorkOSOptions {
  apiKey?: string;
  apiHostname?: string;
  https?: boolean;
  port?: number;
  config?: RequestInit;
  fetchFn?: typeof fetch;
  clientId?: string;
  timeout?: number;
}

export interface AppInfo {
  name: string;
  version?: string;
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/interfaces/post-options.interface.ts",
      content: `export interface PostOptions {
  query?: Record<string, any>;
  idempotencyKey?: string;
  warrantToken?: string;
  skipApiKeyCheck?: boolean;
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/interfaces/get-options.interface.ts",
      content: `export interface GetOptions {
  query?: Record<string, any>;
  accessToken?: string;
  warrantToken?: string;
  skipApiKeyCheck?: boolean;
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/interfaces/pagination-options.interface.ts",
      content: `export interface PaginationOptions {
  limit?: number;
  before?: string | null;
  after?: string | null;
  order?: 'asc' | 'desc';
}`,
      skipIfExists: true,
    },
    {
      path: "src/common/interfaces/request-exception.interface.ts",
      content: `export interface RequestException {
  readonly status: number;
  readonly name: string;
  readonly requestID: string;
  readonly code?: string;
}`,
      skipIfExists: true,
    },
  ];
}

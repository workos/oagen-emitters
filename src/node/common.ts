import type { GeneratedFile } from '@workos/oagen';

export function generateCommon(): GeneratedFile[] {
  return [
    {
      path: 'src/common/utils/pagination.ts',
      content: paginationContent(),
      skipIfExists: true,
      integrateTarget: false,
    },
    {
      path: 'src/common/utils/fetch-and-deserialize.ts',
      content: fetchAndDeserializeContent(),
      skipIfExists: true,
      integrateTarget: true,
    },
    {
      path: 'src/common/serializers/list.serializer.ts',
      content: listSerializerContent(),
      skipIfExists: true,
      integrateTarget: false,
    },
    {
      path: 'src/common/utils/test-utils.ts',
      content: testUtilsContent(),
      skipIfExists: true,
      integrateTarget: true,
    },
  ];
}

function paginationContent(): string {
  return `import type { PaginationOptions } from '../interfaces/pagination-options.interface';

export interface ListMetadata {
  before: string | null;
  after: string | null;
}

export interface List<T> {
  object: 'list';
  data: T[];
  listMetadata: ListMetadata;
}

export interface ListResponse<T> {
  object: 'list';
  data: T[];
  list_metadata: {
    before: string | null;
    after: string | null;
  };
}

export class AutoPaginatable<
  ResourceType,
  ParametersType extends PaginationOptions = PaginationOptions,
> {
  readonly object = 'list' as const;
  readonly options: ParametersType;

  constructor(
    protected list: List<ResourceType>,
    private apiCall: (params: PaginationOptions) => Promise<List<ResourceType>>,
    options?: ParametersType,
  ) {
    this.options = options ?? ({} as ParametersType);
  }

  get data(): ResourceType[] {
    return this.list.data;
  }

  get listMetadata() {
    return this.list.listMetadata;
  }

  private async *generatePages(
    params: PaginationOptions,
  ): AsyncGenerator<ResourceType[]> {
    const result = await this.apiCall({
      ...this.options,
      limit: 100,
      after: params.after,
    });
    yield result.data;
    if (result.listMetadata.after) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      yield* this.generatePages({ after: result.listMetadata.after });
    }
  }

  async autoPagination(): Promise<ResourceType[]> {
    if (this.options.limit) {
      return this.data;
    }
    const results: ResourceType[] = [];
    for await (const page of this.generatePages({
      after: this.options.after,
    })) {
      results.push(...page);
    }
    return results;
  }
}`;
}

function fetchAndDeserializeContent(): string {
  return `import type { WorkOS } from '../../workos';
import type { PaginationOptions } from '../interfaces/pagination-options.interface';
import { AutoPaginatable, type List, type ListResponse } from './pagination';

function setDefaultOptions(
  options?: PaginationOptions,
): Record<string, any> {
  return {
    order: 'desc',
    ...options,
  };
}

function deserializeList<T, U>(
  data: ListResponse<T>,
  deserializeFn: (item: T) => U,
): List<U> {
  return {
    data: data.data.map(deserializeFn),
    listMetadata: {
      before: data.list_metadata.before,
      after: data.list_metadata.after,
    },
  };
}

export const fetchAndDeserialize = async <T, U>(
  workos: WorkOS,
  endpoint: string,
  deserializeFn: (data: T) => U,
  options?: PaginationOptions,
): Promise<List<U>> => {
  const { data } = await workos.get<ListResponse<T>>(endpoint, {
    query: setDefaultOptions(options),
  });
  return deserializeList(data, deserializeFn);
};

export async function createPaginatedList<TResponse, TModel, TOptions extends PaginationOptions>(
  workos: WorkOS,
  endpoint: string,
  deserializeFn: (r: TResponse) => TModel,
  options?: TOptions,
): Promise<AutoPaginatable<TModel, TOptions>> {
  return new AutoPaginatable(
    await fetchAndDeserialize<TResponse, TModel>(workos, endpoint, deserializeFn, options),
    (params) => fetchAndDeserialize<TResponse, TModel>(workos, endpoint, deserializeFn, params),
    options,
  );
}`;
}

function listSerializerContent(): string {
  return `import type { ListMetadata, ListResponse } from '../utils/pagination';

export function deserializeListMetadata(
  metadata: ListResponse<any>['list_metadata'],
): ListMetadata {
  return {
    before: metadata.before,
    after: metadata.after,
  };
}`;
}

function testUtilsContent(): string {
  return `import fetch from 'jest-fetch-mock';

interface MockParams {
  status?: number;
  headers?: Record<string, string>;
  [key: string]: any;
}

export function fetchOnce(
  response: any = {},
  { status = 200, headers, ...rest }: MockParams = {},
) {
  return fetch.once(JSON.stringify(response), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      ...headers,
    },
    ...rest,
  });
}

export function fetchURL(): string {
  return String(fetch.mock.calls[0][0]);
}

export function fetchMethod(): string {
  return String(fetch.mock.calls[0][1]?.method ?? 'GET');
}

export function fetchSearchParams(): Record<string, string> {
  return Object.fromEntries(new URL(fetchURL()).searchParams);
}

export function fetchHeaders(): Record<string, string> {
  const headers = fetch.mock.calls[0][1]?.headers ?? {};
  return headers as Record<string, string>;
}

export function fetchBody({ raw = false } = {}): any {
  const body = fetch.mock.calls[0][1]?.body;
  if (body instanceof URLSearchParams) return body.toString();
  if (raw) return body;
  return JSON.parse(String(body));
}

/**
 * Shared test helper: asserts that the given async function throws when the
 * server responds with 401 Unauthorized.
 */
export function testUnauthorized(fn: () => Promise<any>) {
  it('throws on unauthorized', async () => {
    fetchOnce({ message: 'Unauthorized' }, { status: 401 });
    await expect(fn()).rejects.toThrow('Unauthorized');
  });
}

/**
 * Shared test helper: asserts that a paginated list call returns the expected
 * shape (data array + listMetadata) and hits the correct endpoint.
 */
export function testPaginatedList(
  fn: () => Promise<any>,
  pathContains: string,
) {
  it('returns paginated results', async () => {
    // Caller must have called fetchOnce with the list fixture before invoking fn
    const { data, listMetadata } = await fn();
    expect(fetchURL()).toContain(pathContains);
    expect(fetchSearchParams()).toHaveProperty('order');
    expect(Array.isArray(data)).toBe(true);
    expect(listMetadata).toBeDefined();
  });
}

/**
 * Shared test helper: asserts that a paginated list call returns empty data
 * when the server responds with an empty list.
 */
export function testEmptyResults(fn: () => Promise<any>) {
  it('handles empty results', async () => {
    fetchOnce({ data: [], list_metadata: { before: null, after: null } });
    const { data } = await fn();
    expect(data).toEqual([]);
  });
}

/**
 * Shared test helper: asserts that pagination params are forwarded correctly.
 */
export function testPaginationParams(fn: (opts: any) => Promise<any>, fixture: any) {
  it('forwards pagination params', async () => {
    fetchOnce(fixture);
    await fn({ limit: 10, after: 'cursor_abc' });
    expect(fetchSearchParams()['limit']).toBe('10');
    expect(fetchSearchParams()['after']).toBe('cursor_abc');
  });
}`;
}

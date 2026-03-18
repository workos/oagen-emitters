import type { GeneratedFile } from '@workos/oagen';

export function generateCommon(): GeneratedFile[] {
  return [
    {
      path: 'src/common/utils/pagination.ts',
      content: paginationContent(),
      skipIfExists: true,
    },
    {
      path: 'src/common/utils/fetch-and-deserialize.ts',
      content: fetchAndDeserializeContent(),
      skipIfExists: true,
    },
    {
      path: 'src/common/serializers/list.serializer.ts',
      content: listSerializerContent(),
      skipIfExists: true,
    },
    {
      path: 'src/common/utils/test-utils.ts',
      content: testUtilsContent(),
      skipIfExists: true,
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
import type { List, ListResponse } from './pagination';

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
};`;
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
}`;
}

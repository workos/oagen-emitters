import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { toPascalCase, toSnakeCase } from '@workos/oagen';
// naming utilities used indirectly via resolveResourceClassName
import { resolveResourceClassName } from './resources.js';
import { getMountTarget } from '../shared/resolved-ops.js';

/**
 * Generate the Go client file with service accessors and SDK scaffolding.
 * Produces: workos.go (client constructor + service accessors), go.mod, client.go (HTTP infra).
 */
export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  files.push(generateWorkOSFile(spec, ctx));
  files.push(generateClientFile(spec, ctx));
  files.push(generatePaginationFile(ctx));
  files.push(generateGoMod(ctx));

  return files;
}

/**
 * Deduplicate services by mount target.
 */
function deduplicateByMount(services: Service[], ctx: EmitterContext): Service[] {
  const byTarget = new Map<string, Service>();
  for (const s of services) {
    const target = getMountTarget(s, ctx);
    const existing = byTarget.get(target);
    if (!existing || toPascalCase(s.name) === target) {
      byTarget.set(target, s);
    }
  }
  return [...byTarget.values()];
}

/**
 * Build map of service name -> accessor property name.
 */
export function buildServiceAccessPaths(services: Service[], ctx: EmitterContext): Map<string, string> {
  const topLevel = deduplicateByMount(services, ctx);
  const paths = new Map<string, string>();

  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const prop = toSnakeCase(resolvedName);
    paths.set(service.name, prop);
  }

  // Also map mount targets
  for (const service of services) {
    const target = getMountTarget(service, ctx);
    if (!paths.has(target)) {
      const existing = paths.get(service.name);
      if (existing) paths.set(target, existing);
    }
  }

  return paths;
}

function generateWorkOSFile(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const topLevel = deduplicateByMount(spec.services, ctx);
  const lines: string[] = [];

  lines.push(`// Package ${ctx.namespace} provides a Go client for the WorkOS API.`);
  lines.push(`package ${ctx.namespace}`);
  lines.push('');
  lines.push('import (');
  lines.push('\t"net/http"');
  lines.push('\t"time"');
  lines.push(')');
  lines.push('');

  // Default constants
  lines.push('const (');
  lines.push('\tdefaultBaseURL    = "https://api.workos.com"');
  lines.push('\tdefaultTimeout    = 60 * time.Second');
  lines.push('\tdefaultMaxRetries = 3');
  lines.push(')');
  lines.push('');

  // ClientOption type
  lines.push('// ClientOption configures the Client.');
  lines.push('type ClientOption func(*Client)');
  lines.push('');

  // Functional options
  lines.push('// WithBaseURL sets a custom base URL.');
  lines.push('func WithBaseURL(url string) ClientOption {');
  lines.push('\treturn func(c *Client) { c.baseURL = url }');
  lines.push('}');
  lines.push('');
  lines.push('// WithHTTPClient sets a custom HTTP client.');
  lines.push('func WithHTTPClient(client *http.Client) ClientOption {');
  lines.push('\treturn func(c *Client) { c.httpClient = client }');
  lines.push('}');
  lines.push('');
  lines.push('// WithMaxRetries sets the maximum number of retries.');
  lines.push('func WithMaxRetries(n int) ClientOption {');
  lines.push('\treturn func(c *Client) { c.maxRetries = n }');
  lines.push('}');
  lines.push('');
  lines.push('// WithClientID sets the client ID (used for authentication flows).');
  lines.push('func WithClientID(id string) ClientOption {');
  lines.push('\treturn func(c *Client) { c.clientID = id }');
  lines.push('}');
  lines.push('');

  // RequestOption type
  lines.push('// RequestOption configures a single API request.');
  lines.push('type RequestOption func(*requestConfig)');
  lines.push('');
  lines.push('type requestConfig struct {');
  lines.push('\textraHeaders   http.Header');
  lines.push('\ttimeout        time.Duration');
  lines.push('\tmaxRetries     *int');
  lines.push('\tbaseURL        string');
  lines.push('\tidempotencyKey string');
  lines.push('}');
  lines.push('');
  lines.push('// WithExtraHeaders adds extra headers to the request.');
  lines.push('func WithExtraHeaders(h http.Header) RequestOption {');
  lines.push('\treturn func(r *requestConfig) { r.extraHeaders = h }');
  lines.push('}');
  lines.push('');
  lines.push('// WithTimeout sets a timeout for the request.');
  lines.push('func WithTimeout(d time.Duration) RequestOption {');
  lines.push('\treturn func(r *requestConfig) { r.timeout = d }');
  lines.push('}');
  lines.push('');
  lines.push('// WithIdempotencyKey sets an idempotency key for the request.');
  lines.push('func WithIdempotencyKey(key string) RequestOption {');
  lines.push('\treturn func(r *requestConfig) { r.idempotencyKey = key }');
  lines.push('}');
  lines.push('');
  lines.push('// WithRequestMaxRetries overrides the max retries for a single request.');
  lines.push('func WithRequestMaxRetries(n int) RequestOption {');
  lines.push('\treturn func(r *requestConfig) { r.maxRetries = &n }');
  lines.push('}');
  lines.push('');
  lines.push('// WithRequestBaseURL overrides the base URL for a single request.');
  lines.push('func WithRequestBaseURL(url string) RequestOption {');
  lines.push('\treturn func(r *requestConfig) { r.baseURL = url }');
  lines.push('}');
  lines.push('');

  // Client struct
  lines.push('// Client is the WorkOS API client.');
  lines.push('type Client struct {');
  lines.push('\tapiKey       string');
  lines.push('\tclientID     string');
  lines.push('\tbaseURL      string');
  lines.push('\thttpClient   *http.Client');
  lines.push('\tmaxRetries   int');
  lines.push('');
  // Service fields
  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const fieldNameStr = lowerFirst(resolvedName);
    const serviceTypeName = `${lowerFirst(resolvedName)}Service`;
    lines.push(`\t${fieldNameStr} *${serviceTypeName}`);
  }
  lines.push('}');
  lines.push('');

  // NewClient constructor
  lines.push('// NewClient creates a new WorkOS API client.');
  lines.push('func NewClient(apiKey string, opts ...ClientOption) *Client {');
  lines.push('\tc := &Client{');
  lines.push('\t\tapiKey:     apiKey,');
  lines.push('\t\tbaseURL:    defaultBaseURL,');
  lines.push('\t\thttpClient: &http.Client{Timeout: defaultTimeout},');
  lines.push('\t\tmaxRetries: defaultMaxRetries,');
  lines.push('\t}');
  lines.push('\tfor _, opt := range opts {');
  lines.push('\t\topt(c)');
  lines.push('\t}');
  // Initialize services
  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const fieldNameStr = lowerFirst(resolvedName);
    const serviceTypeName = `${lowerFirst(resolvedName)}Service`;
    lines.push(`\tc.${fieldNameStr} = &${serviceTypeName}{client: c}`);
  }
  lines.push('\treturn c');
  lines.push('}');
  lines.push('');

  // Service accessor methods
  for (const service of topLevel) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const accessorName = resolvedName;
    const fieldNameStr = lowerFirst(resolvedName);
    const serviceTypeName = `${lowerFirst(resolvedName)}Service`;
    lines.push(`// ${accessorName} returns the ${resolvedName} service.`);
    lines.push(`func (c *Client) ${accessorName}() *${serviceTypeName} {`);
    lines.push(`\treturn c.${fieldNameStr}`);
    lines.push('}');
    lines.push('');
  }

  return {
    path: `${ctx.namespace}.go`,
    content: lines.join('\n'),
  };
}

function generateClientFile(_spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const lines: string[] = [];

  lines.push(`package ${ctx.namespace}`);
  lines.push('');
  lines.push('import (');
  lines.push('\t"bytes"');
  lines.push('\t"context"');
  lines.push('\t"encoding/json"');
  lines.push('\t"fmt"');
  lines.push('\t"io"');
  lines.push('\t"math"');
  lines.push('\t"math/rand"');
  lines.push('\t"net/http"');
  lines.push('\t"strconv"');
  lines.push('\t"strings"');
  lines.push('\t"time"');
  lines.push('');
  lines.push('\t"github.com/google/uuid"');
  lines.push(')');
  lines.push('');

  // retryable statuses
  lines.push('var retryableStatuses = map[int]bool{');
  lines.push('\t429: true,');
  lines.push('\t500: true,');
  lines.push('\t502: true,');
  lines.push('\t503: true,');
  lines.push('\t504: true,');
  lines.push('}');
  lines.push('');

  // request method
  lines.push('// request executes an HTTP request with retry logic.');
  lines.push('func (c *Client) request(');
  lines.push('\tctx context.Context,');
  lines.push('\tmethod string,');
  lines.push('\tpath string,');
  lines.push('\tbody interface{},');
  lines.push('\tresult interface{},');
  lines.push('\topts []RequestOption,');
  lines.push(') (*http.Response, error) {');
  lines.push('\tcfg := &requestConfig{}');
  lines.push('\tfor _, opt := range opts {');
  lines.push('\t\topt(cfg)');
  lines.push('\t}');
  lines.push('');
  lines.push('\tbaseURL := c.baseURL');
  lines.push('\tif cfg.baseURL != "" {');
  lines.push('\t\tbaseURL = cfg.baseURL');
  lines.push('\t}');
  lines.push('');
  lines.push('\tmaxRetries := c.maxRetries');
  lines.push('\tif cfg.maxRetries != nil {');
  lines.push('\t\tmaxRetries = *cfg.maxRetries');
  lines.push('\t}');
  lines.push('');
  lines.push('\tidempotencyKey := cfg.idempotencyKey');
  lines.push('\tif method == http.MethodPost && idempotencyKey == "" {');
  lines.push('\t\tidempotencyKey = uuid.New().String()');
  lines.push('\t}');
  lines.push('');
  lines.push('\tvar lastErr error');
  lines.push('\tfor attempt := 0; attempt <= maxRetries; attempt++ {');
  lines.push('\t\tif attempt > 0 {');
  lines.push('\t\t\twait := backoff(attempt, lastErr)');
  lines.push('\t\t\tselect {');
  lines.push('\t\t\tcase <-ctx.Done():');
  lines.push('\t\t\t\treturn nil, ctx.Err()');
  lines.push('\t\t\tcase <-time.After(wait):');
  lines.push('\t\t\t}');
  lines.push('\t\t}');
  lines.push('');
  lines.push('\t\tvar bodyReader io.Reader');
  lines.push('\t\tif body != nil {');
  lines.push('\t\t\tdata, err := json.Marshal(body)');
  lines.push('\t\t\tif err != nil {');
  lines.push('\t\t\t\treturn nil, fmt.Errorf("workos: failed to marshal request body: %w", err)');
  lines.push('\t\t\t}');
  lines.push('\t\t\tbodyReader = bytes.NewReader(data)');
  lines.push('\t\t}');
  lines.push('');
  lines.push('\t\turl := strings.TrimRight(baseURL, "/") + path');
  lines.push('\t\treq, err := http.NewRequestWithContext(ctx, method, url, bodyReader)');
  lines.push('\t\tif err != nil {');
  lines.push('\t\t\treturn nil, fmt.Errorf("workos: failed to create request: %w", err)');
  lines.push('\t\t}');
  lines.push('');
  lines.push('\t\treq.Header.Set("Authorization", "Bearer "+c.apiKey)');
  lines.push('\t\treq.Header.Set("Content-Type", "application/json")');
  lines.push('\t\treq.Header.Set("User-Agent", "workos-go/0.1.0")');
  lines.push('\t\tif idempotencyKey != "" {');
  lines.push('\t\t\treq.Header.Set("Idempotency-Key", idempotencyKey)');
  lines.push('\t\t}');
  lines.push('\t\tif cfg.extraHeaders != nil {');
  lines.push('\t\t\tfor k, vs := range cfg.extraHeaders {');
  lines.push('\t\t\t\tfor _, v := range vs {');
  lines.push('\t\t\t\t\treq.Header.Add(k, v)');
  lines.push('\t\t\t\t}');
  lines.push('\t\t\t}');
  lines.push('\t\t}');
  lines.push('');
  lines.push('\t\thttpClient := c.httpClient');
  lines.push('\t\tif cfg.timeout > 0 {');
  lines.push('\t\t\thttpClient = &http.Client{Timeout: cfg.timeout}');
  lines.push('\t\t}');
  lines.push('');
  lines.push('\t\tresp, err := httpClient.Do(req)');
  lines.push('\t\tif err != nil {');
  lines.push('\t\t\tlastErr = &NetworkError{Err: err}');
  lines.push('\t\t\tcontinue');
  lines.push('\t\t}');
  lines.push('');
  lines.push('\t\tif retryableStatuses[resp.StatusCode] && attempt < maxRetries {');
  lines.push('\t\t\tresp.Body.Close()');
  lines.push('\t\t\tlastErr = parseAPIError(resp)');
  lines.push('\t\t\tcontinue');
  lines.push('\t\t}');
  lines.push('');
  lines.push('\t\tif resp.StatusCode >= 400 {');
  lines.push('\t\t\tdefer resp.Body.Close()');
  lines.push('\t\t\treturn resp, parseAPIError(resp)');
  lines.push('\t\t}');
  lines.push('');
  lines.push('\t\tif result != nil && resp.StatusCode != http.StatusNoContent {');
  lines.push('\t\t\tdefer resp.Body.Close()');
  lines.push('\t\t\tif err := json.NewDecoder(resp.Body).Decode(result); err != nil {');
  lines.push('\t\t\t\treturn resp, fmt.Errorf("workos: failed to decode response: %w", err)');
  lines.push('\t\t\t}');
  lines.push('\t\t} else {');
  lines.push('\t\t\tresp.Body.Close()');
  lines.push('\t\t}');
  lines.push('');
  lines.push('\t\treturn resp, nil');
  lines.push('\t}');
  lines.push('');
  lines.push('\treturn nil, lastErr');
  lines.push('}');
  lines.push('');

  // backoff function
  lines.push('func backoff(attempt int, lastErr error) time.Duration {');
  lines.push('\tbase := 500 * time.Millisecond');
  lines.push('\tmax := 30 * time.Second');
  lines.push('');
  lines.push('\t// Check for Retry-After header');
  lines.push('\tif apiErr, ok := lastErr.(*APIError); ok && apiErr.RetryAfter > 0 {');
  lines.push('\t\treturn time.Duration(apiErr.RetryAfter) * time.Second');
  lines.push('\t}');
  lines.push('');
  lines.push('\twait := time.Duration(float64(base) * math.Pow(2, float64(attempt-1)))');
  lines.push('\tjitter := time.Duration(rand.Int63n(int64(base)))');
  lines.push('\twait += jitter');
  lines.push('\tif wait > max {');
  lines.push('\t\twait = max');
  lines.push('\t}');
  lines.push('\treturn wait');
  lines.push('}');
  lines.push('');

  // parseAPIError
  lines.push('func parseAPIError(resp *http.Response) error {');
  lines.push('\tbody, _ := io.ReadAll(resp.Body)');
  lines.push('');
  lines.push('\tapiErr := &APIError{');
  lines.push('\t\tStatusCode: resp.StatusCode,');
  lines.push('\t\tRequestID:  resp.Header.Get("X-Request-Id"),');
  lines.push('\t}');
  lines.push('');
  lines.push('\tif retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {');
  lines.push('\t\tif seconds, err := strconv.Atoi(retryAfter); err == nil {');
  lines.push('\t\t\tapiErr.RetryAfter = seconds');
  lines.push('\t\t}');
  lines.push('\t}');
  lines.push('');
  lines.push('\t_ = json.Unmarshal(body, apiErr)');
  lines.push('');
  lines.push('\tswitch resp.StatusCode {');
  lines.push('\tcase 401:');
  lines.push('\t\treturn &AuthenticationError{APIError: apiErr}');
  lines.push('\tcase 404:');
  lines.push('\t\treturn &NotFoundError{APIError: apiErr}');
  lines.push('\tcase 422:');
  lines.push('\t\treturn &UnprocessableEntityError{APIError: apiErr}');
  lines.push('\tcase 429:');
  lines.push('\t\treturn &RateLimitExceededError{APIError: apiErr}');
  lines.push('\tdefault:');
  lines.push('\t\tif resp.StatusCode >= 500 {');
  lines.push('\t\t\treturn &ServerError{APIError: apiErr}');
  lines.push('\t\t}');
  lines.push('\t\treturn apiErr');
  lines.push('\t}');
  lines.push('}');

  return {
    path: 'client.go',
    content: lines.join('\n'),
    headerPlacement: 'skip',
  };
}

function generatePaginationFile(ctx: EmitterContext): GeneratedFile {
  const lines: string[] = [];

  lines.push(`package ${ctx.namespace}`);
  lines.push('');
  lines.push('import (');
  lines.push('\t"context"');
  lines.push('\t"encoding/json"');
  lines.push('\t"fmt"');
  lines.push(')');
  lines.push('');

  // listParams and listResponse
  lines.push('type listParams interface{}');
  lines.push('');
  lines.push('type listResponse[T any] struct {');
  lines.push('\tData         []T          `json:"data"`');
  lines.push('\tListMetadata listMetadata `json:"list_metadata"`');
  lines.push('}');
  lines.push('');
  lines.push('type listMetadata struct {');
  lines.push('\tBefore *string `json:"before"`');
  lines.push('\tAfter  *string `json:"after"`');
  lines.push('}');
  lines.push('');

  // Iterator
  lines.push('// Iterator provides auto-pagination over list endpoints.');
  lines.push('type Iterator[T any] struct {');
  lines.push('\tcur      *T');
  lines.push('\titems    []T');
  lines.push('\terr      error');
  lines.push('\tctx      context.Context');
  lines.push('\tclient   *Client');
  lines.push('\tmethod   string');
  lines.push('\tpath     string');
  lines.push('\tparams   listParams');
  lines.push('\tdataPath string');
  lines.push('\topts     []RequestOption');
  lines.push('\tafter    *string');
  lines.push('\tdone     bool');
  lines.push('\tindex    int');
  lines.push('}');
  lines.push('');

  // newIterator
  lines.push('func newIterator[T any](');
  lines.push('\tctx context.Context,');
  lines.push('\tclient *Client,');
  lines.push('\tmethod string,');
  lines.push('\tpath string,');
  lines.push('\tparams listParams,');
  lines.push('\tdataPath string,');
  lines.push('\topts []RequestOption,');
  lines.push(') *Iterator[T] {');
  lines.push('\treturn &Iterator[T]{');
  lines.push('\t\tctx:      ctx,');
  lines.push('\t\tclient:   client,');
  lines.push('\t\tmethod:   method,');
  lines.push('\t\tpath:     path,');
  lines.push('\t\tparams:   params,');
  lines.push('\t\tdataPath: dataPath,');
  lines.push('\t\topts:     opts,');
  lines.push('\t}');
  lines.push('}');
  lines.push('');

  // Next
  lines.push('// Next advances the iterator. Returns false when done or on error.');
  lines.push('func (it *Iterator[T]) Next() bool {');
  lines.push('\tif it.err != nil || it.done {');
  lines.push('\t\treturn false');
  lines.push('\t}');
  lines.push('');
  lines.push('\t// Return next item from current page');
  lines.push('\tif it.index < len(it.items) {');
  lines.push('\t\tit.cur = &it.items[it.index]');
  lines.push('\t\tit.index++');
  lines.push('\t\treturn true');
  lines.push('\t}');
  lines.push('');
  lines.push('\t// Fetch next page');
  lines.push('\tif it.after == nil && it.index > 0 {');
  lines.push('\t\tit.done = true');
  lines.push('\t\treturn false');
  lines.push('\t}');
  lines.push('');
  lines.push('\tvar rawResp json.RawMessage');
  lines.push('\t_, err := it.client.request(it.ctx, it.method, it.path, it.params, &rawResp, it.opts)');
  lines.push('\tif err != nil {');
  lines.push('\t\tit.err = err');
  lines.push('\t\treturn false');
  lines.push('\t}');
  lines.push('');
  lines.push('\tvar page listResponse[T]');
  lines.push('\tif err := json.Unmarshal(rawResp, &page); err != nil {');
  lines.push('\t\tit.err = fmt.Errorf("workos: failed to decode page: %w", err)');
  lines.push('\t\treturn false');
  lines.push('\t}');
  lines.push('');
  lines.push('\tit.items = page.Data');
  lines.push('\tit.index = 0');
  lines.push('\tit.after = page.ListMetadata.After');
  lines.push('');
  lines.push('\tif len(it.items) == 0 {');
  lines.push('\t\tit.done = true');
  lines.push('\t\treturn false');
  lines.push('\t}');
  lines.push('');
  lines.push('\tit.cur = &it.items[it.index]');
  lines.push('\tit.index++');
  lines.push('\treturn true');
  lines.push('}');
  lines.push('');

  // Current
  lines.push('// Current returns the current item.');
  lines.push('func (it *Iterator[T]) Current() *T {');
  lines.push('\treturn it.cur');
  lines.push('}');
  lines.push('');

  // Err
  lines.push('// Err returns any error from the last page fetch.');
  lines.push('func (it *Iterator[T]) Err() error {');
  lines.push('\treturn it.err');
  lines.push('}');

  return {
    path: 'pagination.go',
    content: lines.join('\n'),
    headerPlacement: 'skip',
  };
}

function generateGoMod(_ctx: EmitterContext): GeneratedFile {
  const lines: string[] = [];
  lines.push(`module github.com/workos/workos-go/v2`);
  lines.push('');
  lines.push('go 1.22');
  lines.push('');
  lines.push('require (');
  lines.push('\tgithub.com/google/uuid v1.6.0');
  lines.push('\tgithub.com/stretchr/testify v1.9.0');
  lines.push(')');
  lines.push('');
  lines.push('require (');
  lines.push('\tgithub.com/davecgh/go-spew v1.1.1 // indirect');
  lines.push('\tgithub.com/pmezard/go-difflib v1.0.0 // indirect');
  lines.push('\tgithub.com/stretchr/objx v0.5.2 // indirect');
  lines.push('\tgopkg.in/yaml.v3 v3.0.1 // indirect');
  lines.push(')');

  return {
    path: 'go.mod',
    content: lines.join('\n'),
    headerPlacement: 'skip',
    skipIfExists: true,
  };
}

function lowerFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

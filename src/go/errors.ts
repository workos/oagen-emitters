import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate Go error types.
 * Returns [] -- error types are emitted as static code by generateClient (client.go).
 * This is the hand-maintained runtime contract; generated code should not overwrite it.
 */
export function generateErrors(ctx: EmitterContext): GeneratedFile[] {
  const lines: string[] = [];

  lines.push(`package ${ctx.namespace}`);
  lines.push('');
  lines.push('import "fmt"');
  lines.push('');

  // Base APIError
  lines.push('// APIError represents an error returned by the WorkOS API.');
  lines.push('type APIError struct {');
  lines.push('\tStatusCode int    `json:"-"`');
  lines.push('\tRequestID  string `json:"-"`');
  lines.push('\tRetryAfter int    `json:"-"`');
  lines.push('\tCode       string `json:"code"`');
  lines.push('\tMessage    string `json:"message"`');
  lines.push('}');
  lines.push('');
  lines.push('func (e *APIError) Error() string {');
  lines.push(
    '\treturn fmt.Sprintf("workos: %d %s: %s (request_id: %s)", e.StatusCode, e.Code, e.Message, e.RequestID)',
  );
  lines.push('}');
  lines.push('');

  // Typed error wrappers
  const errorTypes = [
    ['AuthenticationError', '401 authentication errors'],
    ['NotFoundError', '404 not found errors'],
    ['UnprocessableEntityError', '422 validation errors'],
    ['RateLimitExceededError', '429 rate limit errors'],
    ['ServerError', '5xx server errors'],
  ];

  for (const [name, desc] of errorTypes) {
    lines.push(`// ${name} represents ${desc}.`);
    lines.push(`type ${name} struct {`);
    lines.push('\t*APIError');
    lines.push('}');
    lines.push('');
    lines.push(`func (e *${name}) Error() string { return e.APIError.Error() }`);
    lines.push(`func (e *${name}) Unwrap() error { return e.APIError }`);
    lines.push('');
  }

  // NetworkError
  lines.push('// NetworkError represents a connection failure.');
  lines.push('type NetworkError struct {');
  lines.push('\tErr error');
  lines.push('}');
  lines.push('');
  lines.push('func (e *NetworkError) Error() string {');
  lines.push('\treturn fmt.Sprintf("workos: network error: %v", e.Err)');
  lines.push('}');
  lines.push('');
  lines.push('func (e *NetworkError) Unwrap() error { return e.Err }');

  return [
    {
      path: 'errors.go',
      content: lines.join('\n'),
      headerPlacement: 'skip',
    },
  ];
}

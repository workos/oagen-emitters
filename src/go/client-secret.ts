import { goStringLiteral } from './strings.js';

/** Local variable holding the client secret inside a generated method. */
export const CLIENT_SECRET_LOCAL = 'clientSecret';

/**
 * Statements that resolve `client_secret` through the hand-written
 * `(*Client).clientSecret(method string) (string, error)` accessor and return
 * its error before any request is built.
 *
 * Generated code never reads the client's API key for `client_secret` itself:
 * the accessor decides whether a client without an API key leaves the field
 * out (an empty string, dropped by `omitempty`) or cannot make the call at all
 * (an error).
 *
 * @param method Go method name, used by the accessor in its error message.
 * @param errorReturn Operands of the `return` taken on error (`nil, err` or `err`).
 */
export function clientSecretLines(method: string, errorReturn: string): string[] {
  return [
    `\t${CLIENT_SECRET_LOCAL}, err := s.client.clientSecret(${goStringLiteral(method)})`,
    '\tif err != nil {',
    `\t\treturn ${errorReturn}`,
    '\t}',
  ];
}

/**
 * Fail generation when `client_secret` is inferred into a query string. The
 * accessor returns an error, which only a method that sends a request body is
 * generated to return; URL builders return a bare string and paginated methods
 * an iterator. A client secret does not belong in a URL either.
 */
export function assertNoClientSecretInQuery(fields: string[], method: string): void {
  if (!fields.includes('client_secret')) return;
  throw new Error(
    `Go emitter: ${method} infers client_secret into a query string. ` +
      'Only operations with a request body can infer client_secret.',
  );
}

import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec, resolveOperations } from '@workos/oagen';
import { generateResources } from '../../src/go/resources.js';

it.skipIf(spawnSync('go', ['version']).status !== 0)(
  'preserves large integers while supplying required request constants',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'go-request-numbers-'));
    try {
      const specPath = join(dir, 'spec.json');
      writeFileSync(
        specPath,
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'Request numbers', version: '1' },
          paths: {
            '/items': {
              post: {
                operationId: 'createItem',
                tags: ['Probe'],
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          kind: { type: 'string', const: 'add' },
                          sequence: { type: 'integer', format: 'int64' },
                          sequences: { type: 'array', items: { type: 'integer', format: 'int64' } },
                        },
                        required: ['kind', 'sequence', 'sequences'],
                      },
                    },
                  },
                },
                responses: { '204': { description: 'Created' } },
              },
            },
          },
        }),
      );
      const spec = await parseSpec(specPath);
      const files = generateResources(spec.services, {
        spec,
        namespace: 'workos',
        namespacePascal: 'WorkOS',
        resolvedOperations: resolveOperations(spec),
      });
      const source = files[0].content.replace('import (', 'import (\n\t"testing"');
      const testPath = join(dir, 'request_test.go');
      writeFileSync(
        testPath,
        `${source}
type Client struct{}
type RequestOption struct{}
func (*Client) request(context.Context, string, string, any, any, any, []RequestOption) (any, error) {
  return nil, nil
}
func TestRequestNumbers(t *testing.T) {
  for _, n := range []int{9007199254740993, -9007199254740993, 9223372036854775807} {
    data, err := json.Marshal(ProbeCreateItemParams{Sequence: n, Sequences: []int{n}})
    if err != nil { t.Fatal(err) }
    var body map[string]json.RawMessage
    if err := json.Unmarshal(data, &body); err != nil { t.Fatal(err) }
    if string(body["kind"]) != fmt.Sprintf("%q", "add") { t.Fatal(string(data)) }
    if string(body["sequence"]) != fmt.Sprint(n) { t.Fatal("integer precision lost:", string(data)) }
    if string(body["sequences"]) != fmt.Sprintf("[%d]", n) { t.Fatal("nested integer precision lost:", string(data)) }
  }
}
`,
      );
      const result = spawnSync('go', ['test', testPath], { encoding: 'utf8', timeout: 30000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

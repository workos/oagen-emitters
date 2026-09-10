import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import type { ApiSpec, EmitterContext, Enum, GeneratedFile, Model, Service } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateModels as pythonModels } from '../src/python/models.js';
import { generateEnums as pythonEnums } from '../src/python/enums.js';
import { generateResources as pythonResources } from '../src/python/resources.js';
import { pythonLiteral } from '../src/python/wrappers.js';
import { mapTypeRef as pythonType, mapTypeRefUnquoted as pythonUnquotedType } from '../src/python/type-map.js';
import { generateEnums as nodeEnums } from '../src/node/enums.js';
import { generateDiscriminatedFiles } from '../src/node/discriminated-models.js';
import { generateResources as nodeResources } from '../src/node/resources.js';
import { generateEnums as goEnums } from '../src/go/enums.js';
import { generateModels as nodeModels } from '../src/node/models.js';
import { mapTypeRef as nodeType, mapWireTypeRef as nodeWireType } from '../src/node/type-map.js';
import { docComment } from '../src/node/utils.js';
import { generateEnums as phpEnums } from '../src/php/enums.js';
import { generateModels as phpModels } from '../src/php/models.js';
import { phpDocComment } from '../src/php/utils.js';
import { generateModels as goModels } from '../src/go/models.js';
import { generateResources as goResources } from '../src/go/resources.js';
import { goStructTag } from '../src/go/strings.js';
import { generateEnums as dotnetEnums } from '../src/dotnet/enums.js';
import { emitJsonPropertyAttributes } from '../src/dotnet/type-map.js';
import { csLiteral, escapeCsAttributeString, escapeXml } from '../src/dotnet/naming.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};
function context(spec: Partial<ApiSpec> = {}): EmitterContext {
  return { namespace: 'workos', namespacePascal: 'WorkOS', spec: { ...emptySpec, ...spec } };
}
const text = (files: GeneratedFile[]) => files.map((file) => file.content).join('\n');
const docPayload = 'Documentation."""\n    _injected = True\n    _doc = """internal\\';
const literalPayload = 'x"; _injected = True; _ = "y\\\n\r\t\0';
const blockPayload = 'end */ globalThis._injected = true; /* still docs';
const enumSpec = (value: string, description?: string): Enum[] => [
  {
    name: 'Status',
    values: [
      { name: 'active', value: 'active' },
      { name: 'evil', value, description },
    ],
  },
];
function service(description?: string): Service {
  return {
    name: 'Things',
    operations: [
      {
        name: 'createThing',
        httpMethod: 'post',
        path: '/things',
        pathParams: [],
        queryParams: [{ name: 'query', type: { kind: 'primitive', type: 'string' }, required: false, description }],
        headerParams: [],
        requestBody: { kind: 'model', name: 'Thing' },
        response: { kind: 'model', name: 'Thing' },
        description,
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  };
}
function model(name = literalPayload, description = docPayload): Model {
  return {
    name: 'Thing',
    description,
    fields: [
      { name, domainName: 'value', required: true, type: { kind: 'literal', value: literalPayload }, description },
      { name: 'optional', required: false, type: { kind: 'primitive', type: 'string' }, description },
    ],
  };
}

// Parse generated Python with the actual target parser. Never inherit SDK credentials.
// /usr/bin avoids local version-manager shims; CI's python3 is the fallback.
const python = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';
function pythonAst(files: GeneratedFile[]): any[] {
  const result = spawnSync(
    python,
    [
      '-I',
      '-c',
      `
import ast, json, sys
result = []
for file in json.load(sys.stdin):
    tree = ast.parse(file['content'], filename=file['path'])
    # An injected statement must not survive outside literal/comment content.
    assert not any(isinstance(n, ast.Name) and n.id == '_injected' for n in ast.walk(tree))
    result.append({
        'constants': [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)],
        'docs': [ast.get_docstring(n, clean=False) for n in ast.walk(tree) if isinstance(n, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))],
    })
print(json.dumps(result))
`,
    ],
    { input: JSON.stringify(files), encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

function evaluateTypeScript(source: string): Record<string, unknown> {
  const output = stripTypeScriptTypes(source).replace(/^export /gm, '');
  const sandbox = { _injected: false, result: {} };
  runInNewContext(output + '\nresult = typeof Status === "undefined" ? {} : { Status };', sandbox, { timeout: 1000 });
  expect(sandbox._injected).toBe(false);
  return sandbox.result;
}

describe('VULN-2366: spec metadata remains data', () => {
  it('Python model and field docstrings, wire keys, and literal defaults parse intact', () => {
    const models = [model()];
    const ast = pythonAst(pythonModels(models, context({ models })));
    const constants = ast.flatMap((file) => file.constants);
    expect(constants).toContain(docPayload);
    expect(constants).toContain(literalPayload);
    expect(ast.flatMap((file) => file.docs)).toContain(docPayload);
    for (const render of [pythonType, pythonUnquotedType]) {
      const type = render({ kind: 'literal', value: literalPayload });
      expect(pythonAst([{ path: 'type.py', content: `value: ${type}` }])[0].constants).toContain(literalPayload);
    }
    expect(
      pythonAst([{ path: 'default.py', content: `value = ${pythonLiteral(literalPayload)}` }])[0].constants,
    ).toEqual([literalPayload]);
  });

  it('Python enum values and member docs remain literals', () => {
    const enums = enumSpec(literalPayload, docPayload);
    const constants = pythonAst(pythonEnums(enums, context({ enums }))).flatMap((file) => file.constants);
    expect(constants.filter((value: string) => value === literalPayload).length).toBeGreaterThanOrEqual(2);
    expect(constants).toContain(docPayload);
  });

  it('Python operation and parameter docs cannot close sync or async docstrings', () => {
    const models = [model('value')];
    const services = [service(docPayload)];
    const docs = pythonAst(pythonResources(services, context({ models, services })))
      .flatMap((file) => file.docs)
      .filter(Boolean);
    expect(docs.filter((doc: string) => doc.includes('_injected = True')).length).toBeGreaterThanOrEqual(2);
  });

  it('Python dispatcher and inline-union keys cannot inject expressions, including f-string braces', () => {
    const key = 'kind"\\\n{_injected}';
    const mapping = { [literalPayload]: 'Variant' };
    const models: Model[] = [
      { name: 'Variant', fields: [] },
      { name: 'Dispatch', fields: [], description: docPayload, discriminator: { property: key, mapping } } as Model,
      {
        name: 'Container',
        fields: [
          {
            name: literalPayload,
            domainName: 'variant',
            required: true,
            type: {
              kind: 'union',
              variants: [{ kind: 'model', name: 'Variant' }],
              discriminator: { property: key, mapping },
            },
          },
        ],
      },
    ];
    const constants = pythonAst(pythonModels(models, context({ models }))).flatMap((file) => file.constants);
    expect(constants).toContain(key);
    expect(constants).toContain(literalPayload);
    expect(constants.some((value: string) => value.includes("Unknown discriminator '" + key))).toBe(true);
    delete models[1].description;
    pythonAst(pythonModels(models, context({ models })));
  });

  it('Node enum values and literal types preserve quotes, slashes, controls, and Unicode separators', () => {
    const value = "x', injected: (globalThis._injected = true), y: 'z\\\n\r\t\0\u2028\u2029";
    const enums = enumSpec(value, blockPayload);
    const source = text(nodeEnums(enums, context({ enums })));
    const exported = evaluateTypeScript(source);
    expect(Object.values(exported.Status as object)).toContain(value);
    for (const render of [nodeType, nodeWireType]) {
      evaluateTypeScript(`export type Value = ${render({ kind: 'literal', value })};`);
    }
  });

  it('Node and PHP block comments neutralize every closing delimiter', () => {
    for (const render of [docComment, phpDocComment]) {
      for (const payload of [blockPayload, `${blockPayload}\n${blockPayload}`]) {
        const output = render(payload).join('\n');
        expect(output.match(/\*\//g)).toHaveLength(1);
        expect(output).toContain('*\u200b/');
      }
    }
    const models = [model('value', blockPayload)];
    const services = [service(blockPayload)];
    const files = nodeModels(models, context({ models, services })).filter((file) =>
      file.path.endsWith('.interface.ts'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      evaluateTypeScript(file.content);
    }
    const resources = text(nodeResources(services, context({ models, services })));
    expect(resources).toContain('*\u200b/');
    expect(resources).not.toContain(blockPayload);
  });

  it('Node discriminator metadata cannot escape interfaces or serializer expressions', () => {
    const key = "kind'\\\n${globalThis._injected = true}";
    const value = "value'\\\n";
    const files = generateDiscriminatedFiles(
      new Map([
        [
          'Thing',
          {
            modelDir: 'things',
            depDirMap: new Map(),
            shape: {
              modelName: 'Thing',
              baseFields: [],
              discriminatorProperty: key,
              discriminatorPropertyDomain: 'kind',
              discriminatorDescription: blockPayload,
              variants: [{ nameSuffix: 'Variant', discriminatorValue: value, fields: [] }],
            },
          },
        ],
      ]),
      context(),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      // Type-only imports disappear during stripping; the functions remain inert
      // until explicitly called and must parse without evaluating metadata.
      evaluateTypeScript(file.content);
      expect(file.content).not.toContain(blockPayload);
    }
  });
  it('Node extends baseline unions without reinterpreting escaped wire values', () => {
    const enums = enumSpec("new'\\value");
    const baseline = "'active' | 'a\\'b' | 'path\\\\name' | CustomStatus";
    const ctx = context({ enums });
    ctx.apiSurface = {
      classes: {},
      interfaces: {},
      enums: {},
      exports: {},
      typeAliases: { Status: { value: baseline, sourceFile: 'src/common/interfaces/status.interface.ts' } },
    } as unknown as EmitterContext['apiSurface'];
    const source = text(nodeEnums(enums, ctx));
    expect(source).toContain(baseline + ' | ');
    evaluateTypeScript(source);
  });

  it('Go enum descriptions keep every line commented and enum values quoted', () => {
    const value = 'x"\\\n';
    const enums = enumSpec(value, 'description\n)\nfunc init() { panic("injected") }\n/*');
    const source = text(goEnums(enums, context({ enums })));
    expect(source).toContain(' = ' + JSON.stringify(value));
    expect(source).not.toMatch(/^func init/m);
    expect(source).toContain('// func init()');
    if (spawnSync('gofmt', ['-h'], { timeout: 5000 }).error) return;
    const parsed = spawnSync('gofmt', [], {
      input: source,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
      timeout: 10000,
    });
    expect(parsed.stderr).toBe('');
    expect(parsed.status).toBe(0);
  });

  it('PHP enum and model values stay inside single-quoted strings', () => {
    const value = "x';} $GLOBALS['_injected'] = true; //\\\n${still_data}";
    const enums = enumSpec(value, blockPayload);
    const models = [model(value, blockPayload)];
    const generated = [...phpEnums(enums, context({ enums })), ...phpModels(models, context({ models }))];
    for (const file of generated) {
      expect(file.content).not.toContain("'x';}");
    }
    expect(text(generated)).toContain("'x\\';}");
    if (spawnSync('php', ['--version'], { timeout: 5000 }).status !== 0) return;
    const result = spawnSync('php', ['-n'], {
      input: `<?php\n${generated.map((file) => file.content).join('\n')}\necho json_encode([Status::Evil->value, isset($GLOBALS['_injected'])]);`,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
      timeout: 10000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([value, false]);
  });

  it('Go models and request structs escape both layers of tags', () => {
    const key = 'wire`"\\\n}\nfunc init() { panic("injected") }\n//';
    const models = [model(key, 'A thing.')];
    const services = [service()];
    const ctx = context({ models, services });
    const source = text(goModels(models, ctx));
    expect(source).toContain(goStructTag({ json: key }));
    expect(text(goResources(services, ctx))).toContain(goStructTag({ json: key, url: '-' }));
    expect(goStructTag({ json: 'id,omitempty' })).toBe('`json:"id,omitempty"`');
    if (spawnSync('gofmt', ['-h'], { timeout: 5000 }).error) return;
    const parsed = spawnSync('gofmt', [], {
      input: source,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
      timeout: 10000,
    });
    expect(parsed.stderr).toBe('');
    expect(parsed.status).toBe(0);
  });

  it('Go tag values round-trip through reflect, including literal backticks', () => {
    if (spawnSync('go', ['version'], { timeout: 5000 }).status !== 0) return;
    const key = 'wire`"\\\n\t';
    const dir = mkdtempSync(join(tmpdir(), 'oagen-tags-'));
    try {
      const file = join(dir, 'main.go');
      writeFileSync(
        file,
        `package main\nimport ("reflect"; "encoding/json"; "os")\nfunc main() {\n type Value struct { Field string ${goStructTag({ json: key })} }\n json.NewEncoder(os.Stdout).Encode(reflect.TypeOf(Value{}).Field(0).Tag.Get("json"))\n}\n`,
      );
      const result = spawnSync('go', ['run', '-p=2', file], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, GOCACHE: join(tmpdir(), 'oagen-go-test-cache') },
        timeout: 60000,
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 65000);

  it('.NET enum attributes, wire names, and XML docs escape all lexical newlines', () => {
    const value = 'x")]\r\n\u0085\u2028\u2029\\\0';
    const enums = enumSpec(value, 'docs\n_injected = true;\r\u0085\u2028\u2029<&>');
    const models: Model[] = [
      { name: 'Thing', fields: [{ name: 'status', required: true, type: { kind: 'enum', name: 'Status' } }] },
    ];
    const content = text(dotnetEnums(enums, context({ enums, models })));
    const literal = '"x\\\")]\\r\\n\\u0085\\u2028\\u2029\\\\\\u0000"';
    expect(csLiteral(value)).toBe(literal);
    expect(escapeCsAttributeString(value)).toBe(literal.slice(1, -1));
    expect(content).toContain(`[EnumMember(Value = ${literal})]`);
    expect(content).not.toMatch(/^_injected/m);
    expect(escapeXml('\r\n\u0085\u2028\u2029')).toBe('&#13;&#10;&#133;&#8232;&#8233;');
    for (const isRequiredEnum of [false, true]) {
      const attributes = emitJsonPropertyAttributes(value, { explicitWireName: true, isRequiredEnum }).join('\n');
      expect(attributes).toContain(`[STJS.JsonPropertyName(${literal})]`);
      expect(attributes).toContain(`[JsonProperty(${literal}`);
    }
  });
});

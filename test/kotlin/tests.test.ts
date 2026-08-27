import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateTests } from '../../src/kotlin/tests.js';
import { generateEnums } from '../../src/kotlin/enums.js';
import type { EmitterContext, ApiSpec, Service, Model, ResolvedOperation } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

const models: Model[] = [
  {
    name: 'Organization',
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    ],
  },
];

const services: Service[] = [
  {
    name: 'Organizations',
    operations: [
      {
        name: 'getOrganization',
        httpMethod: 'get',
        path: '/organizations/{id}',
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'Organization' },
        errors: [],
        injectIdempotencyKey: false,
      },
      {
        name: 'deleteOrganization',
        httpMethod: 'delete',
        path: '/organizations/{id}',
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'primitive', type: 'unknown' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const spec: ApiSpec = {
  name: 'TestAPI',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services,
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
};

function buildResolvedOps(services: Service[]): ResolvedOperation[] {
  return services.flatMap((svc) =>
    svc.operations.map((op) => ({
      service: svc,
      operation: op,
      methodName: op.name,
      mountOn: svc.name,
    })),
  ) as ResolvedOperation[];
}

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec,
  resolvedOperations: buildResolvedOps(services),
};

describe('kotlin/tests', () => {
  it('generates per-mount-group test files', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path.includes('OrganizationsTest.kt'));
    expect(testFile).toBeDefined();

    const content = testFile!.content;
    expect(content).toContain('class OrganizationsTest');
    expect(content).toContain('TestBase');
    expect(content).toContain('@Test');
  });

  it('generates happy-path test for void/delete methods', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path.includes('OrganizationsTest.kt'))!;
    const content = testFile.content;

    // Delete method should have an active test, not a @Disabled placeholder.
    // Method name is trimmed from deleteOrganization -> delete by resolveMethodName.
    expect(content).toContain('delete completes without throwing');
    expect(content).not.toContain('@Disabled("generator: could not synthesize required arguments for delete")');
  });

  it('generates field-value assertions for non-void responses', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path.includes('OrganizationsTest.kt'))!;
    const content = testFile.content;

    // GET method returning Organization should assert field values
    expect(content).toContain('assertEquals("sample", result.id)');
    expect(content).toContain('assertEquals("sample", result.name)');
  });

  it('generates error-mapping tests', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path.includes('OrganizationsTest.kt'))!;
    const content = testFile.content;

    expect(content).toContain('UnauthorizedException');
    expect(content).toContain('NotFoundException');
    expect(content).toContain('RateLimitException');
    expect(content).toContain('GenericServerException');
  });

  it('generates round-trip test using synthJson for broader coverage', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const roundTrip = files.find((f) => f.path.includes('GeneratedModelRoundTripTest.kt'));
    expect(roundTrip).toBeDefined();

    const content = roundTrip!.content;
    expect(content).toContain('Organization round-trips through Jackson');
    expect(content).toContain('assertEquals(tree1, tree2)');
  });

  it('generates forward-compat test with OffsetDateTime round-trip', () => {
    generateEnums([], ctx);
    const files = generateTests(spec, ctx);
    const fwdCompat = files.find((f) => f.path.includes('GeneratedForwardCompatTest.kt'));
    expect(fwdCompat).toBeDefined();

    const content = fwdCompat!.content;
    expect(content).toContain('OffsetDateTime round-trips');
    expect(content).toContain('assertEquals(parsed.toInstant(), reparsed.toInstant())');
  });

  const roundTripModel = (name: string): Model => ({
    name,
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    ],
  });

  it('scoped run: emits the round-trip test with only in-scope fixtures when there is no prior file', () => {
    // The round-trip suite is a single whole-suite AGGREGATE file, but it is
    // reconciled PER MODEL in a scoped run so an in-scope model whose shape
    // changed still gets a refreshed fixture (the bug: skipping it wholesale
    // left in-scope fixtures stale). With no prior file to freeze from, an
    // out-of-scope model is dropped rather than emitted with a fresh block whose
    // per-model .kt this run does not write.
    const scopedModels: Model[] = [
      roundTripModel('Organization'), // in scope
      roundTripModel('Directory'), // out of scope but ON disk
    ];
    const scopedSpec: ApiSpec = { ...spec, models: scopedModels };
    const scopedCtx: EmitterContext = {
      ...ctx,
      spec: scopedSpec,
      resolvedOperations: buildResolvedOps(services),
      scopedServices: new Set(['Organizations']),
      scopedModelNames: new Set(['Organization']),
      priorTargetManifestPaths: new Set(['src/main/kotlin/com/workos/models/Directory.kt']),
    };

    generateEnums([], scopedCtx);
    const files = generateTests(scopedSpec, scopedCtx);

    const roundTrip = files.find((f) => f.path.endsWith('GeneratedModelRoundTripTest.kt'));
    expect(roundTrip).toBeDefined();
    expect(roundTrip!.content).toContain('Organization round-trips through Jackson');
    // Out of scope + no prior on disk → dropped (no fresh block for an unemitted file).
    expect(roundTrip!.content).not.toContain('Directory round-trips through Jackson');

    // Forward-compat is a representative slice (not a per-model block set), so it
    // stays skipped under scoping; the per-service class stays scoped and emitted.
    expect(files.some((f) => f.path.endsWith('GeneratedForwardCompatTest.kt'))).toBe(false);
    expect(files.some((f) => f.path.includes('OrganizationsTest.kt'))).toBe(true);
  });

  it('scoped run: refreshes in-scope fixture but freezes out-of-scope one to its prior on-disk block', () => {
    // Write a prior round-trip file: Directory (out of scope) carries an EXTRA
    // field in its fixture that the current spec's model lacks. The scoped run
    // must keep Directory's block byte-for-byte (freeze) while refreshing
    // Organization from the current spec.
    const outputDir = mkdtempSync(join(tmpdir(), 'oagen-rt-'));
    const rtPath = join(outputDir, 'src/test/kotlin/com/workos/models/GeneratedModelRoundTripTest.kt');
    mkdirSync(dirname(rtPath), { recursive: true });
    const priorDirectoryMethod = [
      '  @Test',
      '  fun `Directory round-trips through Jackson`() {',
      '    val json = "{\\"id\\": \\"sample\\", \\"name\\": \\"sample\\", \\"legacy\\": \\"kept\\"}"',
      '    val parsed = mapper.readValue(json, Directory::class.java)',
      '    val reserialized = mapper.writeValueAsString(parsed)',
      '    val tree1 = mapper.readTree(json)',
      '    val tree2 = mapper.readTree(reserialized)',
      '    assertEquals(tree1, tree2)',
      '  }',
    ].join('\n');
    writeFileSync(
      rtPath,
      [
        'package com.workos.models',
        '',
        'import com.workos.common.json.ObjectMapperFactory',
        'import org.junit.jupiter.api.Assertions.assertEquals',
        'import org.junit.jupiter.api.Test',
        '',
        'class GeneratedModelRoundTripTest {',
        '  private val mapper = ObjectMapperFactory.create()',
        '',
        priorDirectoryMethod,
        '}',
        '',
      ].join('\n'),
    );

    const scopedModels: Model[] = [roundTripModel('Organization'), roundTripModel('Directory')];
    const scopedSpec: ApiSpec = { ...spec, models: scopedModels };
    const scopedCtx: EmitterContext = {
      ...ctx,
      spec: scopedSpec,
      outputDir,
      resolvedOperations: buildResolvedOps(services),
      scopedServices: new Set(['Organizations']),
      scopedModelNames: new Set(['Organization']),
      priorTargetManifestPaths: new Set(['src/main/kotlin/com/workos/models/Directory.kt']),
    };

    const roundTrip = generateTests(scopedSpec, scopedCtx).find((f) =>
      f.path.endsWith('GeneratedModelRoundTripTest.kt'),
    )!;
    expect(roundTrip).toBeDefined();
    // In-scope: refreshed from the current spec.
    expect(roundTrip.content).toContain('Organization round-trips through Jackson');
    // Out-of-scope: frozen to the prior block verbatim (extra "legacy" field kept).
    expect(roundTrip.content).toContain('Directory round-trips through Jackson');
    expect(roundTrip.content).toContain('\\"legacy\\": \\"kept\\"');

    rmSync(outputDir, { recursive: true, force: true });
  });

  it('scoped run: drops an in-scope model block when the model stops qualifying for a fixture', () => {
    // Regression (workos-kotlin CI): Organization is IN SCOPE and the current
    // spec gives it an OPTIONAL field, so the all-fields-required fixture gate
    // disqualifies it and no fresh block is produced. Its `.kt` IS regenerated
    // though (now carrying `val provider: String? = null`), so carrying the
    // prior block over resurrected a fixture that omits the field while Jackson
    // serializes it as null — `assertEquals(tree1, tree2)` then fails and the
    // SDK build breaks. The stale in-scope block must be DROPPED; Directory
    // (out of scope, untouched on disk) must still be carried over.
    const outputDir = mkdtempSync(join(tmpdir(), 'oagen-rt-'));
    const rtPath = join(outputDir, 'src/test/kotlin/com/workos/models/GeneratedModelRoundTripTest.kt');
    mkdirSync(dirname(rtPath), { recursive: true });
    const method = (cls: string) =>
      [
        '  @Test',
        `  fun \`${cls} round-trips through Jackson\`() {`,
        '    val json = "{\\"id\\": \\"sample\\", \\"name\\": \\"sample\\"}"',
        `    val parsed = mapper.readValue(json, ${cls}::class.java)`,
        '    val reserialized = mapper.writeValueAsString(parsed)',
        '    val tree1 = mapper.readTree(json)',
        '    val tree2 = mapper.readTree(reserialized)',
        '    assertEquals(tree1, tree2)',
        '  }',
      ].join('\n');
    writeFileSync(
      rtPath,
      [
        'package com.workos.models',
        '',
        'import com.workos.common.json.ObjectMapperFactory',
        'import org.junit.jupiter.api.Assertions.assertEquals',
        'import org.junit.jupiter.api.Test',
        '',
        'class GeneratedModelRoundTripTest {',
        '  private val mapper = ObjectMapperFactory.create()',
        '',
        method('Organization'),
        '',
        method('Directory'),
        '}',
        '',
      ].join('\n'),
    );

    const disqualified: Model = {
      name: 'Organization',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        // Newly added and OPTIONAL → the model no longer round-trips from a
        // required-fields-only fixture.
        { name: 'provider', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
    };
    const scopedSpec: ApiSpec = { ...spec, models: [disqualified, roundTripModel('Directory')] };
    const scopedCtx: EmitterContext = {
      ...ctx,
      spec: scopedSpec,
      outputDir,
      resolvedOperations: buildResolvedOps(services),
      scopedServices: new Set(['Organizations']),
      scopedModelNames: new Set(['Organization']),
      priorTargetManifestPaths: new Set(['src/main/kotlin/com/workos/models/Directory.kt']),
    };

    const roundTrip = generateTests(scopedSpec, scopedCtx).find((f) =>
      f.path.endsWith('GeneratedModelRoundTripTest.kt'),
    )!;
    expect(roundTrip).toBeDefined();
    expect(roundTrip.content).not.toContain('Organization round-trips through Jackson');
    expect(roundTrip.content).toContain('Directory round-trips through Jackson');

    rmSync(outputDir, { recursive: true, force: true });
  });

  it('scoped run: does NOT emit the round-trip test when the prior file exists but is unreadable', () => {
    // Guard against silent data loss: if the prior aggregate can't be read, we
    // must not overwrite it with only fresh in-scope blocks (which would drop
    // every out-of-scope frozen fixture). Simulate "exists but unreadable" with
    // a DIRECTORY at the file path — readFileSync throws EISDIR.
    const outputDir = mkdtempSync(join(tmpdir(), 'oagen-rt-'));
    const rtPath = join(outputDir, 'src/test/kotlin/com/workos/models/GeneratedModelRoundTripTest.kt');
    mkdirSync(rtPath, { recursive: true }); // a dir where a file is expected

    const scopedSpec: ApiSpec = { ...spec, models: [roundTripModel('Organization')] };
    const scopedCtx: EmitterContext = {
      ...ctx,
      spec: scopedSpec,
      outputDir,
      resolvedOperations: buildResolvedOps(services),
      scopedServices: new Set(['Organizations']),
      scopedModelNames: new Set(['Organization']),
    };

    const files = generateTests(scopedSpec, scopedCtx);
    // Left untouched on disk → not in the emitted set.
    expect(files.some((f) => f.path.endsWith('GeneratedModelRoundTripTest.kt'))).toBe(false);

    rmSync(outputDir, { recursive: true, force: true });
  });

  it('emits valid ISO-8601 for date-time fields in round-trip fixtures', () => {
    const dtModels: Model[] = [
      {
        name: 'Event',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'created_at',
            type: { kind: 'primitive', type: 'string', format: 'date-time' },
            required: true,
          },
        ],
      },
    ];
    const dtSpec: ApiSpec = { ...spec, models: dtModels };
    const dtCtx: EmitterContext = {
      ...ctx,
      spec: dtSpec,
      resolvedOperations: buildResolvedOps(services),
    };

    generateEnums([], dtCtx);
    const files = generateTests(dtSpec, dtCtx);
    const roundTrip = files.find((f) => f.path.includes('GeneratedModelRoundTripTest.kt'));
    expect(roundTrip).toBeDefined();

    const content = roundTrip!.content;
    // Should use ISO-8601 timestamp, not "sample"
    expect(content).toContain('2024-01-01T00:00:00Z');
    expect(content).not.toMatch(/created_at.*"sample"/);
  });
});

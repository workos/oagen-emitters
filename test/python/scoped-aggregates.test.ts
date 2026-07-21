import { describe, it, expect } from 'vitest';
import { generateModels } from '../../src/python/models.js';
import { generateTests } from '../../src/python/tests.js';
import type { EmitterContext, ApiSpec, Service, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';

// A scoped run selects the `Widgets` mount and pulls in only `WidgetA`. The
// spec ALSO contains models belonging to the out-of-scope `Gadgets` service:
//   - GadgetBrandNew  : brand-new, NOT in the prior manifest  → must NOT be
//                       referenced by any aggregate (the ADDITION bug).
//   - GadgetOnDisk    : already on disk (recorded in the prior manifest) →
//                       must be RETAINED by the barrel.
// The prior manifest also records `gadget_renamed.py`, a per-model file for a
// model that the current spec no longer produces (renamed/removed) → must be
// RETAINED via a wholesale `import *` so stale out-of-scope code still resolves.
const services: Service[] = [
  {
    name: 'Widgets',
    operations: [
      {
        name: 'getWidget',
        httpMethod: 'get',
        path: '/widgets/{id}',
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'WidgetA' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
  {
    name: 'Gadgets',
    operations: [
      {
        name: 'getGadgetBrandNew',
        httpMethod: 'get',
        path: '/gadgets/brand-new/{id}',
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'GadgetBrandNew' },
        errors: [],
        injectIdempotencyKey: false,
      },
      {
        name: 'getGadgetOnDisk',
        httpMethod: 'get',
        path: '/gadgets/on-disk/{id}',
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'GadgetOnDisk' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const models: Model[] = [
  {
    name: 'WidgetA',
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
    ],
  },
  {
    name: 'GadgetBrandNew',
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'color', type: { kind: 'primitive', type: 'string' }, required: true },
    ],
  },
  {
    name: 'GadgetOnDisk',
    fields: [
      { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      { name: 'size', type: { kind: 'primitive', type: 'string' }, required: true },
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

// Scoped to the Widgets mount: only WidgetA is in-scope. The prior manifest
// records GadgetOnDisk's file plus a now-removed gadget_renamed.py file.
function scopedCtx(): EmitterContext {
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec,
    scopedServices: new Set(['Widgets']),
    scopedModelNames: new Set(['WidgetA']),
    scopedEnumNames: new Set<string>(),
    priorTargetManifestPaths: new Set([
      'src/workos/widgets/models/widget_a.py',
      'src/workos/gadgets/models/gadget_on_disk.py',
      'src/workos/gadgets/models/gadget_renamed.py',
      // Fixtures live under tests/fixtures/ and are recorded in the manifest too;
      // the on-disk gadget's fixture is retained the same way its model file is.
      'tests/fixtures/widget_a.json',
      'tests/fixtures/gadget_on_disk.json',
    ]),
  } as EmitterContext;
}

describe('python scoped aggregates', () => {
  describe('models barrel (__init__.py)', () => {
    it('writes only the in-scope per-model file', () => {
      const files = generateModels(models, scopedCtx());
      const modelFiles = files.filter((f) => f.path.endsWith('.py') && f.path.includes('/models/'));
      const writtenModelFiles = modelFiles.filter((f) => !f.path.endsWith('__init__.py'));
      // Only WidgetA's file is emitted; the two out-of-scope gadget files are not.
      expect(writtenModelFiles.map((f) => f.path)).toEqual(['src/workos/widgets/models/widget_a.py']);
    });

    it('does NOT reference a brand-new out-of-scope model in any barrel (ADDITION fix)', () => {
      const files = generateModels(models, scopedCtx());
      const barrels = files.filter((f) => f.path.endsWith('__init__.py'));
      for (const barrel of barrels) {
        expect(barrel.content).not.toContain('GadgetBrandNew');
        expect(barrel.content).not.toContain('gadget_brand_new');
      }
    });

    it('RETAINS an on-disk out-of-scope model in its barrel (no dangling drop)', () => {
      const files = generateModels(models, scopedCtx());
      const gadgetBarrel = files.find((f) => f.path === 'src/workos/gadgets/models/__init__.py');
      expect(gadgetBarrel).toBeDefined();
      // GadgetOnDisk is still in the spec but out of scope; its file already
      // exists on disk (prior manifest), so the barrel keeps re-exporting it.
      expect(gadgetBarrel!.content).toContain('from .gadget_on_disk import GadgetOnDisk as GadgetOnDisk');
    });

    it('RETAINS a renamed/removed on-disk file via wholesale import (REMOVAL fix)', () => {
      const files = generateModels(models, scopedCtx());
      const gadgetBarrel = files.find((f) => f.path === 'src/workos/gadgets/models/__init__.py');
      expect(gadgetBarrel).toBeDefined();
      // gadget_renamed.py is on disk (prior manifest) but no longer produced by
      // the spec; retain it wholesale so stale out-of-scope imports resolve.
      expect(gadgetBarrel!.content).toContain('from .gadget_renamed import *  # noqa: F401,F403');
    });

    it('still references the in-scope model in its own barrel', () => {
      const files = generateModels(models, scopedCtx());
      const widgetBarrel = files.find((f) => f.path === 'src/workos/widgets/models/__init__.py');
      expect(widgetBarrel).toBeDefined();
      expect(widgetBarrel!.content).toContain('from .widget_a import WidgetA as WidgetA');
    });
  });

  describe('round-trip test + fixtures', () => {
    // A scoped run regenerates the SELECTED service's per-dir round-trip file in
    // lockstep with its models, covering ONLY in-scope models, and leaves
    // out-of-scope services' files untouched (not emitted → scoped no-prune
    // keeps them). This replaces the old wholesale skip that left one shared
    // file asserting the old shape of a just-regenerated model.
    it('emits the selected service dir round-trip file covering only in-scope models', () => {
      const files = generateTests(spec, scopedCtx());
      const widgetRoundTrip = files.find((f) => f.path === 'tests/test_widgets_models_round_trip.py');
      expect(widgetRoundTrip).toBeDefined();
      expect(widgetRoundTrip!.content).toContain('def test_widget_a_round_trip(self):');
      expect(widgetRoundTrip!.content).toContain('from workos.widgets.models import WidgetA');
      // The out-of-scope gadget models get no test — their untouched on-disk
      // models are never asserted against with a fresh (possibly drifted) fixture.
      expect(widgetRoundTrip!.content).not.toContain('GadgetBrandNew');
      expect(widgetRoundTrip!.content).not.toContain('GadgetOnDisk');
    });

    it('does NOT emit a round-trip file for an out-of-scope service dir', () => {
      const files = generateTests(spec, scopedCtx());
      expect(files.find((f) => f.path === 'tests/test_gadgets_models_round_trip.py')).toBeUndefined();
    });

    it('does not resurrect the pre-split monolith when it is absent from disk', () => {
      const files = generateTests(spec, scopedCtx());
      expect(files.find((f) => f.path === 'tests/test_models_round_trip.py')).toBeUndefined();
    });

    it('overwrites the pre-split monolith with an inert placeholder while it is still on disk', () => {
      const ctx = scopedCtx();
      ctx.priorTargetManifestPaths!.add('tests/test_models_round_trip.py');
      const files = generateTests(spec, ctx);
      const legacy = files.find((f) => f.path === 'tests/test_models_round_trip.py');
      expect(legacy).toBeDefined();
      expect(legacy!.content).toContain('moved to per-service');
      // Inert: no test classes or functions, so it passes as it awaits pruning.
      expect(legacy!.content).not.toContain('class Test');
      expect(legacy!.content).not.toContain('def test_');
    });

    it('emits a fixture ONLY for the selected in-scope model', () => {
      const files = generateTests(spec, scopedCtx());
      // The selected service's model gets its fixture.
      expect(files.find((f) => f.path === 'tests/fixtures/widget_a.json')).toBeDefined();
      // No fixture for the brand-new out-of-scope model.
      expect(files.find((f) => f.path === 'tests/fixtures/gadget_brand_new.json')).toBeUndefined();
      // The on-disk out-of-scope model is NOT re-fixtured: minimal scoped
      // generation leaves every other service's fixtures untouched on disk,
      // even ones recorded in the prior manifest.
      expect(files.find((f) => f.path === 'tests/fixtures/gadget_on_disk.json')).toBeUndefined();
    });
  });

  describe('full (non-scoped) run is unaffected', () => {
    it('references every model in its barrel and round-trip test', () => {
      const fullCtx: EmitterContext = {
        namespace: 'workos',
        namespacePascal: 'WorkOS',
        spec,
      };
      const modelFiles = generateModels(models, fullCtx);
      const gadgetBarrel = modelFiles.find((f) => f.path === 'src/workos/gadgets/models/__init__.py');
      expect(gadgetBarrel!.content).toContain('GadgetBrandNew');
      expect(gadgetBarrel!.content).toContain('GadgetOnDisk');
      // No retention import on a full run.
      expect(gadgetBarrel!.content).not.toContain('import *');

      const testFiles = generateTests(spec, fullCtx);
      // Full run emits a per-dir round-trip file for every service dir.
      const roundTrip = testFiles.find((f) => f.path === 'tests/test_gadgets_models_round_trip.py');
      expect(roundTrip!.content).toContain('GadgetBrandNew');
      expect(testFiles.find((f) => f.path === 'tests/fixtures/gadget_brand_new.json')).toBeDefined();
    });
  });

  // A service the spec just added that the SDK has never generated (no files in
  // the prior manifest) and that this scoped run did not select must not get a
  // stray empty `<svc>/models/__init__.py`. Without the guard the empty-barrel
  // pass — which walks the full spec — would materialize one, leaving an "Agents"
  // package in a Pipes-only PR.
  // Regression guard: a dir's aggregate round-trip file is regenerated because
  // ONE of its models is in scope, then must NOT be overwritten with only that
  // in-scope subset — the dir's other models, out of scope this run but still
  // present on disk (model + fixture untouched, never pruned), must keep their
  // round-trip coverage. This is the scoped-drop bug: a real batch scoped to
  // user_management deleted ~330 round-trip tests for on-disk event models
  // (SessionCreated, InvitationCreated, ...) that share the user_management dir.
  describe('round-trip coverage retention for same-dir out-of-scope models', () => {
    const mkOp = (name: string, path: string, model: string) => ({
      name,
      httpMethod: 'get' as const,
      path,
      pathParams: [{ name: 'id', type: { kind: 'primitive' as const, type: 'string' as const }, required: true }],
      queryParams: [],
      headerParams: [],
      response: { kind: 'model' as const, name: model },
      errors: [],
      injectIdempotencyKey: false,
    });
    const localModels: Model[] = [
      // In scope this run.
      { name: 'WidgetA', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      // Out of scope this run, but its model + fixture are on disk (prior manifest).
      { name: 'WidgetLegacy', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      // Out of scope AND brand-new (no fixture on disk) → nothing to test.
      { name: 'WidgetBrandNew', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
    ];
    const localSpec: ApiSpec = {
      name: 'TestAPI',
      version: '1.0.0',
      baseUrl: 'https://api.workos.com',
      services: [
        {
          name: 'Widgets',
          operations: [
            mkOp('getWidget', '/widgets/{id}', 'WidgetA'),
            mkOp('getWidgetLegacy', '/widgets/legacy/{id}', 'WidgetLegacy'),
            mkOp('getWidgetBrandNew', '/widgets/brand-new/{id}', 'WidgetBrandNew'),
          ],
        },
      ],
      models: localModels,
      enums: [],
      sdk: defaultSdkBehavior(),
    };
    // Scoped to Widgets; only WidgetA is regenerated this run. The prior manifest
    // records WidgetLegacy's model + fixture (left untouched on disk), but NOT
    // WidgetBrandNew's.
    const ctx = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: localSpec,
      scopedServices: new Set(['Widgets']),
      scopedModelNames: new Set(['WidgetA']),
      scopedEnumNames: new Set<string>(),
      priorTargetManifestPaths: new Set([
        'src/workos/widgets/models/widget_a.py',
        'src/workos/widgets/models/widget_legacy.py',
        'tests/fixtures/widget_a.json',
        'tests/fixtures/widget_legacy.json',
      ]),
    } as EmitterContext;

    it('RETAINS the out-of-scope on-disk model and excludes the brand-new one', () => {
      const files = generateTests(localSpec, ctx);
      const rt = files.find((f) => f.path === 'tests/test_widgets_models_round_trip.py');
      expect(rt).toBeDefined();
      // In-scope model is covered.
      expect(rt!.content).toContain('def test_widget_a_round_trip(self):');
      // Out-of-scope model still on disk → coverage retained (the regression).
      expect(rt!.content).toContain('def test_widget_legacy_round_trip(self):');
      expect(rt!.content).toContain('WidgetLegacy');
      // Out-of-scope model with no on-disk fixture → no test, no dangling import.
      expect(rt!.content).not.toContain('WidgetBrandNew');
    });
  });

  describe('brand-new out-of-scope service gets no empty models barrel', () => {
    const localServices: Service[] = [
      {
        name: 'Widgets',
        operations: [
          {
            name: 'getWidget',
            httpMethod: 'get',
            path: '/widgets/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'WidgetA' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
      {
        name: 'Agents',
        operations: [
          {
            name: 'getAgent',
            httpMethod: 'get',
            path: '/agents/{id}',
            pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'AgentThing' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const localModels: Model[] = [
      { name: 'WidgetA', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      { name: 'AgentThing', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
    ];
    const localSpec: ApiSpec = {
      name: 'TestAPI',
      version: '1.0.0',
      baseUrl: 'https://api.workos.com',
      services: localServices,
      models: localModels,
      enums: [],
      sdk: defaultSdkBehavior(),
    };
    // Scoped to Widgets; the prior manifest has no record of Agents at all.
    const ctx = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec: localSpec,
      scopedServices: new Set(['Widgets']),
      scopedModelNames: new Set(['WidgetA']),
      scopedEnumNames: new Set<string>(),
      priorTargetManifestPaths: new Set(['src/workos/widgets/models/widget_a.py']),
    } as EmitterContext;

    it('skips the empty barrel for the never-generated, out-of-scope service', () => {
      const files = generateModels(localModels, ctx);
      expect(files.find((f) => f.path === 'src/workos/agents/models/__init__.py')).toBeUndefined();
      // The selected service's barrel is still produced.
      expect(files.find((f) => f.path === 'src/workos/widgets/models/__init__.py')).toBeDefined();
    });
  });
});

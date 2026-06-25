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
    it('does not reference or fixture a brand-new out-of-scope model', () => {
      const files = generateTests(spec, scopedCtx());
      const roundTrip = files.find((f) => f.path === 'tests/test_models_round_trip.py');
      expect(roundTrip).toBeDefined();
      expect(roundTrip!.content).not.toContain('GadgetBrandNew');
      // No fixture for the brand-new out-of-scope model.
      expect(files.find((f) => f.path === 'tests/fixtures/gadget_brand_new.json')).toBeUndefined();
    });

    it('keeps the in-scope model and retains the on-disk out-of-scope model', () => {
      const files = generateTests(spec, scopedCtx());
      const roundTrip = files.find((f) => f.path === 'tests/test_models_round_trip.py');
      expect(roundTrip!.content).toContain('WidgetA');
      // GadgetOnDisk's per-model file exists on disk (prior manifest), so the
      // round-trip test may still import it and its fixture is emitted.
      expect(roundTrip!.content).toContain('GadgetOnDisk');
      expect(files.find((f) => f.path === 'tests/fixtures/gadget_on_disk.json')).toBeDefined();
      expect(files.find((f) => f.path === 'tests/fixtures/widget_a.json')).toBeDefined();
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
      const roundTrip = testFiles.find((f) => f.path === 'tests/test_models_round_trip.py');
      expect(roundTrip!.content).toContain('GadgetBrandNew');
      expect(testFiles.find((f) => f.path === 'tests/fixtures/gadget_brand_new.json')).toBeDefined();
    });
  });
});

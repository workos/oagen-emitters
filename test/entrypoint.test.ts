import { describe, it, expect } from 'vitest';

/**
 * Verify the public entrypoint exports the plugin bundle
 * and all intended direct symbols (emitters + extractors).
 */
describe('public entrypoint (@workos/oagen-emitters)', () => {
  it('exports workosEmittersPlugin', async () => {
    const mod = await import('../src/index.js');
    expect(mod.workosEmittersPlugin).toBeDefined();
    expect(mod.workosEmittersPlugin.emitters).toBeDefined();
    expect(mod.workosEmittersPlugin.extractors).toBeDefined();
    expect(mod.workosEmittersPlugin.smokeRunners).toBeDefined();
  });

  it('exports all individual emitters', async () => {
    const mod = await import('../src/index.js');
    const expectedEmitters = [
      'nodeEmitter',
      'pythonEmitter',
      'phpEmitter',
      'goEmitter',
      'dotnetEmitter',
      'kotlinEmitter',
      'rubyEmitter',
      'rustEmitter',
      'iosEmitter',
    ];
    for (const name of expectedEmitters) {
      expect(mod).toHaveProperty(name);
      expect((mod as Record<string, unknown>)[name]).toHaveProperty('language');
    }
  });

  it('exports all individual extractors', async () => {
    const mod = await import('../src/index.js');
    const expectedExtractors = [
      'nodeExtractor',
      'rubyExtractor',
      'pythonExtractor',
      'phpExtractor',
      'goExtractor',
      'rustExtractor',
      'kotlinExtractor',
      'dotnetExtractor',
      'elixirExtractor',
    ];
    for (const name of expectedExtractors) {
      expect(mod).toHaveProperty(name);
      expect((mod as Record<string, unknown>)[name]).toHaveProperty('language');
    }
  });

  it('plugin bundle emitters match individual emitter exports', async () => {
    const mod = await import('../src/index.js');
    const pluginLanguages = mod.workosEmittersPlugin.emitters!.map((e) => e.language);
    const directEmitters = [
      mod.nodeEmitter,
      mod.pythonEmitter,
      mod.phpEmitter,
      mod.goEmitter,
      mod.dotnetEmitter,
      mod.kotlinEmitter,
      mod.rubyEmitter,
      mod.rustEmitter,
      mod.iosEmitter,
    ];
    for (const emitter of directEmitters) {
      expect(pluginLanguages).toContain(emitter.language);
    }
    expect(pluginLanguages).toHaveLength(directEmitters.length);
  });

  it('plugin bundle extractors match individual extractor exports', async () => {
    const mod = await import('../src/index.js');
    const pluginLanguages = mod.workosEmittersPlugin.extractors!.map((e) => e.language);
    const directExtractors = [
      mod.nodeExtractor,
      mod.rubyExtractor,
      mod.pythonExtractor,
      mod.phpExtractor,
      mod.goExtractor,
      mod.rustExtractor,
      mod.kotlinExtractor,
      mod.dotnetExtractor,
      mod.elixirExtractor,
    ];
    for (const extractor of directExtractors) {
      expect(pluginLanguages).toContain(extractor.language);
    }
    expect(pluginLanguages).toHaveLength(directExtractors.length);
  });
});

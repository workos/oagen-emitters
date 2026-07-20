import { describe, it, expect } from 'vitest';
import { workosEmittersPlugin } from '../src/plugin.js';

describe('workosEmittersPlugin', () => {
  it('exports emitters for all supported languages', () => {
    const languages = workosEmittersPlugin.emitters!.map((e) => e.language);
    expect(languages).toContain('node');
    expect(languages).toContain('python');
    expect(languages).toContain('php');
    expect(languages).toContain('go');
    expect(languages).toContain('dotnet');
    expect(languages).toContain('kotlin');
    expect(languages).toContain('ruby');
    expect(languages).toContain('rust');
    expect(languages).toContain('ios');
    expect(languages).toHaveLength(9);
  });

  it('exports extractors for all supported languages', () => {
    const languages = workosEmittersPlugin.extractors!.map((e) => e.language);
    expect(languages).toContain('node');
    expect(languages).toContain('python');
    expect(languages).toContain('php');
    expect(languages).toContain('go');
    expect(languages).toContain('ruby');
    expect(languages).toContain('rust');
    expect(languages).toContain('kotlin');
    expect(languages).toContain('dotnet');
    expect(languages).toContain('elixir');
    expect(languages).toHaveLength(9);
  });

  it('exports smoke runners for all supported languages', () => {
    const runners = Object.keys(workosEmittersPlugin.smokeRunners!);
    expect(runners).toContain('node');
    expect(runners).toContain('python');
    expect(runners).toContain('php');
    expect(runners).toContain('go');
    expect(runners).toContain('ruby');
    expect(runners).toContain('rust');
    expect(runners).toContain('kotlin');
    expect(runners).toContain('dotnet');
    expect(runners).toContain('elixir');
    expect(runners).toContain('ios');
    expect(runners).toHaveLength(10);
  });

  it('smoke runner paths are absolute', () => {
    for (const [, runnerPath] of Object.entries(workosEmittersPlugin.smokeRunners!)) {
      expect(runnerPath).toMatch(/^\//);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  escapeReserved as ktEscape,
  ktStringLiteral as ktString,
  ktLiteral as ktLit,
} from '../../src/kotlin/naming.js';
import {
  escapeReserved as androidEscape,
  ktStringLiteral as androidString,
  ktLiteral as androidLit,
} from '../../src/android/naming.js';

/**
 * `kotlin` and `android` are two emitters targeting the SAME language, so they each
 * carry Kotlin-syntax primitives: the reserved-word set, string-literal escaping,
 * and scalar-literal rendering. That is duplicated policy, and duplicated policy
 * drifts silently.
 *
 * These helpers are deliberately NOT consolidated into one module yet: doing so
 * means editing the emitter behind the published `workos-kotlin` SDK, which is out
 * of scope for the Android work that surfaced this. This test is the interim
 * guard — it turns silent drift into a failing build, and documents the single
 * known divergence so it stays a deliberate choice rather than an accident.
 *
 * If the helpers are consolidated later, delete this file.
 */
describe('kotlin/android Kotlin-syntax parity', () => {
  const reservedOf = (emitter: 'kotlin' | 'android'): Set<string> => {
    const src = readFileSync(join(process.cwd(), 'src', emitter, 'naming.ts'), 'utf8');
    const block = /KOTLIN_RESERVED = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(block, `${emitter}: KOTLIN_RESERVED not found`).toBeTruthy();
    return new Set([...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]));
  };

  it('reserved-word sets are identical', () => {
    const k = reservedOf('kotlin');
    const a = reservedOf('android');
    expect(
      [...a].filter((w) => !k.has(w)),
      'words only in android',
    ).toEqual([]);
    expect(
      [...k].filter((w) => !a.has(w)),
      'words only in kotlin',
    ).toEqual([]);
  });

  it('escapeReserved agrees on every reserved word and on ordinary identifiers', () => {
    for (const word of reservedOf('kotlin')) {
      expect(androidEscape(word), `escaping '${word}'`).toBe(ktEscape(word));
    }
    for (const word of ['id', 'name', 'organizationId', 'get', 'value', 'data']) {
      expect(androidEscape(word), `escaping '${word}'`).toBe(ktEscape(word));
    }
  });

  it('ktLiteral agrees on scalars', () => {
    for (const v of ['plain', 'has "quote"', 'has $dollar', 'a\\b', 42, -1, 1.5, true, false] as const) {
      expect(androidLit(v), `ktLiteral(${JSON.stringify(v)})`).toBe(ktLit(v));
    }
  });

  it('ktStringLiteral agrees on everything except the documented tab divergence', () => {
    // Both must neutralize the dangerous cases identically: `$` starts a Kotlin
    // template, `"` closes the literal, `\` starts an escape.
    for (const v of ['plain', 'has "quote"', '${System.getenv()}', 'a\\b', 'line\nbreak', 'ret\rurn']) {
      expect(androidString(v), `ktStringLiteral(${JSON.stringify(v)})`).toBe(ktString(v));
    }
  });

  it('pins the one known divergence: android escapes tab, kotlin does not', () => {
    // Verified output-neutral for the current spec (zero literal tabs in the IR),
    // which is why it has not forced a consolidation. If this test starts failing,
    // one of the two emitters changed its escaping and the other must follow.
    expect(androidString('a\tb')).toBe('"a\\tb"');
    expect(ktString('a\tb')).toBe('"a\tb"');
  });
});

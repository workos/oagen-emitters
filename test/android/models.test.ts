import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateModels } from '../../src/android/models.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('android/models', () => {
  it('returns empty for no models', () => {
    expect(generateModels([], ctx)).toEqual([]);
  });

  it('generates a @Serializable data class with required and nullable fields', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        description: 'An organization.',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: false },
        ],
      },
    ];
    const files = generateModels(models, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/main/kotlin/com/workos/android/models/Organization.kt');
    const content = files[0].content;
    expect(content).toContain('package com.workos.android.models');
    expect(content).toContain('@Serializable');
    expect(content).toContain('public data class Organization(');
    expect(content).toContain('public val id: String,');
    expect(content).toContain('public val name: String,');
    // nullable field gets `= null` so callers can omit it
    expect(content).toContain('public val createdAt: Instant? = null,');
    // explicit wire-key mapping
    expect(content).toContain('@SerialName("created_at")');
    // Instant import is pulled in for date-time
    expect(content).toContain('import kotlinx.datetime.Instant');
  });

  it('orders required properties before nullable ones', () => {
    const models: Model[] = [
      {
        name: 'Thing',
        fields: [
          { name: 'optional_first', type: { kind: 'primitive', type: 'string' }, required: false },
          { name: 'required_second', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];
    const content = generateModels(models, ctx)[0].content;
    expect(content.indexOf('requiredSecond')).toBeLessThan(content.indexOf('optionalFirst'));
  });

  it('maps arrays, maps, model refs and enum refs', () => {
    const models: Model[] = [
      {
        name: 'User',
        fields: [
          { name: 'roles', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: true },
          {
            name: 'metadata',
            type: { kind: 'map', valueType: { kind: 'primitive', type: 'string' } },
            required: false,
          },
          { name: 'profile', type: { kind: 'model', name: 'Profile' }, required: true },
          { name: 'state', type: { kind: 'enum', name: 'UserState' }, required: true },
        ],
      },
    ];
    const specWithRefs: ApiSpec = {
      ...emptySpec,
      models: [...models, { name: 'Profile', fields: [] }],
      enums: [{ name: 'UserState', values: [{ name: 'active', value: 'active' }] }],
    };
    const content = generateModels(models, { ...ctx, spec: specWithRefs })[0].content;
    expect(content).toContain('public val roles: List<String>,');
    expect(content).toContain('public val profile: Profile,');
    expect(content).toContain('public val state: UserState,');
    expect(content).toContain('public val metadata: Map<String, String>? = null,');
    // A referenced enum lives in a sibling package, so it needs an import.
    expect(content).toContain('import com.workos.android.enums.UserState');
    // A referenced model is in this file's own package — Kotlin resolves it
    // without an import, and ktlint flags a redundant same-package import.
    expect(content).not.toContain('import com.workos.android.models.Profile');
  });

  it('escapes Kotlin reserved words used as field names', () => {
    const models: Model[] = [
      {
        name: 'Event',
        fields: [
          { name: 'object', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'in', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];
    const content = generateModels(models, ctx)[0].content;
    expect(content).toContain('public val `object`: String,');
    expect(content).toContain('public val `in`: String,');
    // the wire key stays unescaped
    expect(content).toContain('@SerialName("object")');
  });

  it('degrades a field-less model to a plain class (data class needs a parameter)', () => {
    const content = generateModels([{ name: 'Empty', fields: [] }], ctx)[0].content;
    expect(content).toContain('public class Empty');
    expect(content).not.toContain('data class');
  });

  it('marks deprecated fields with @Deprecated', () => {
    const models: Model[] = [
      {
        name: 'Thing',
        fields: [{ name: 'old', type: { kind: 'primitive', type: 'string' }, required: true, deprecated: true }],
      },
    ];
    expect(generateModels(models, ctx)[0].content).toContain('@Deprecated(');
  });

  it('honors domainName for the property while keeping the wire key', () => {
    const models: Model[] = [
      {
        name: 'Connection',
        fields: [
          {
            name: 'connection_type',
            domainName: 'type',
            type: { kind: 'primitive', type: 'string' },
            required: true,
          },
        ],
      },
    ];
    const content = generateModels(models, ctx)[0].content;
    expect(content).toContain('public val type: String,');
    expect(content).toContain('@SerialName("connection_type")');
  });

  it('de-duplicates repeated property names from flattened union variants', () => {
    const models: Model[] = [
      {
        name: 'Owner',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];
    const content = generateModels(models, ctx)[0].content;
    expect(content.match(/public val id: String/g)).toHaveLength(1);
  });

  it('renders a full model deterministically', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        description: 'An organization.',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true, description: 'The id.' },
          { name: 'external_id', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ];
    expect(generateModels(models, ctx)[0].content).toMatchInlineSnapshot(`
      "package com.workos.android.models

      import kotlinx.serialization.SerialName
      import kotlinx.serialization.Serializable

      /** An organization. */
      @Serializable
      public data class Organization(
          /** The id. */
          @SerialName("id")
          public val id: String,
          @SerialName("external_id")
          public val externalId: String? = null,
      )"
    `);
  });
});

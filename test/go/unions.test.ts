import { describe, it, expect } from 'vitest';
import type { ApiSpec, EmitterContext, Model, TypeRef, UnionType } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { goEmitter } from '../../src/index.js';
import {
  emittableModelPredicate,
  hasUnionWrapper,
  isWrappableDiscriminatedUnion,
  prepareGoUnions,
  unionWrapperName,
} from '../../src/go/unions.js';
import { mapTypeRef } from '../../src/go/type-map.js';

/**
 * A `value` field whose type differs per variant (`boolean | string | number`,
 * keyed on `value_type`). The flat-superset flatten cannot represent this — it
 * throws — so it is the shape that forces a real wrapper.
 */
function flagValueUnion(): UnionType {
  return {
    kind: 'union',
    compositionKind: 'oneOf',
    discriminator: {
      property: 'value_type',
      mapping: { boolean: 'FlagValue', string: 'StringFlagValue', number: 'NumberFlagValue' },
    },
    variants: [
      { kind: 'model', name: 'FlagValue' },
      { kind: 'model', name: 'StringFlagValue' },
      { kind: 'model', name: 'NumberFlagValue' },
    ],
  };
}

/** A discriminated oneOf with exactly one member. */
function singleMemberUnion(): UnionType {
  return {
    kind: 'union',
    compositionKind: 'oneOf',
    discriminator: { property: 'type', mapping: { organization: 'SettingTarget' } },
    variants: [{ kind: 'model', name: 'SettingTarget' }],
  };
}

function variantModels(): Model[] {
  return [
    {
      name: 'FlagValue',
      fields: [
        { name: 'value_type', type: { kind: 'literal', value: 'boolean' }, required: true },
        { name: 'value', type: { kind: 'primitive', type: 'boolean' }, required: true },
      ],
    },
    {
      name: 'StringFlagValue',
      fields: [
        { name: 'value_type', type: { kind: 'literal', value: 'string' }, required: true },
        { name: 'value', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    },
    {
      name: 'NumberFlagValue',
      fields: [
        { name: 'value_type', type: { kind: 'literal', value: 'number' }, required: true },
        { name: 'value', type: { kind: 'primitive', type: 'number' }, required: true },
      ],
    },
    {
      name: 'SettingTarget',
      fields: [
        { name: 'type', type: { kind: 'literal', value: 'organization' }, required: true },
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    },
  ];
}

function modelsWith(fieldType: TypeRef, extra: Model[] = variantModels()): Model[] {
  return [{ name: 'FeatureFlag', fields: [{ name: 'value', type: fieldType, required: true }] }, ...extra];
}

function contextFor(models: Model[], overrides: Partial<EmitterContext> = {}): EmitterContext {
  const spec: ApiSpec = {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services: [],
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
  return { namespace: 'workos', namespacePascal: 'WorkOS', spec, ...overrides };
}

/** Run the emitter end to end and return the generated files by path. */
function emit(models: Model[], overrides: Partial<EmitterContext> = {}): Map<string, string> {
  const ctx = contextFor(models, overrides);
  return new Map(goEmitter.generateModels(models, ctx).map((f) => [f.path, f.content]));
}

/** Prime the per-run registry the way the emitter does, then return the names. */
function prime(models: Model[]): string[] {
  const ctx = contextFor(models);
  return prepareGoUnions(models, ctx.spec.enums, emittableModelPredicate(models, ctx)).map((u) => u.name);
}

describe('go/unions — wrappable detection', () => {
  it('accepts a discriminated oneOf of named variants', () => {
    expect(isWrappableDiscriminatedUnion(flagValueUnion())).toBe(true);
    prime(modelsWith(flagValueUnion()));
    expect(unionWrapperName(flagValueUnion())).toBe('FlagValueUnion');
  });

  it('accepts a single-member discriminated oneOf', () => {
    expect(isWrappableDiscriminatedUnion(singleMemberUnion())).toBe(true);
    prime(modelsWith(singleMemberUnion()));
    expect(unionWrapperName(singleMemberUnion())).toBe('SettingTargetUnion');
  });

  it('rejects a union with no discriminator', () => {
    const union: UnionType = {
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [
        { kind: 'primitive', type: 'string' },
        { kind: 'primitive', type: 'boolean' },
      ],
    };
    expect(isWrappableDiscriminatedUnion(union)).toBe(false);
    expect(unionWrapperName(union)).toBeNull();
    expect(hasUnionWrapper(union)).toBe(false);
  });

  it('reports hasUnionWrapper only for unions this run actually wrapped', () => {
    // This is the flatten opt-out: a union that shape-qualifies but got no
    // wrapper must still be flattened, or its later-variant fields vanish.
    prime([]);
    expect(isWrappableDiscriminatedUnion(flagValueUnion())).toBe(true);
    expect(hasUnionWrapper(flagValueUnion())).toBe(false);

    prime(modelsWith(flagValueUnion()));
    expect(hasUnionWrapper(flagValueUnion())).toBe(true);
  });

  it('rejects an allOf composition', () => {
    const union = { ...flagValueUnion(), compositionKind: 'allOf' as const };
    expect(isWrappableDiscriminatedUnion(union)).toBe(false);
  });

  it('rejects a discriminator with an empty mapping', () => {
    const union: UnionType = { ...flagValueUnion(), discriminator: { property: 'value_type', mapping: {} } };
    expect(isWrappableDiscriminatedUnion(union)).toBe(false);
  });

  it('rejects a union whose variants are not all named models', () => {
    const union: UnionType = {
      ...flagValueUnion(),
      variants: [
        { kind: 'model', name: 'FlagValue' },
        { kind: 'primitive', type: 'string' },
      ],
    };
    expect(isWrappableDiscriminatedUnion(union)).toBe(false);
  });
});

describe('go/type-map — union references', () => {
  it('points a discriminated-union field at the wrapper', () => {
    prime(modelsWith(flagValueUnion()));
    expect(mapTypeRef(flagValueUnion())).toBe('*FlagValueUnion');
  });

  it('points a single-member discriminated union at the wrapper too', () => {
    // Not collapsed to the lone variant: adding a second member later must be
    // additive rather than a type replacement.
    prime(modelsWith(singleMemberUnion()));
    expect(mapTypeRef(singleMemberUnion())).toBe('*SettingTargetUnion');
  });

  it('leaves a non-discriminated heterogeneous union as interface{}', () => {
    const union: UnionType = {
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [
        { kind: 'primitive', type: 'string' },
        { kind: 'primitive', type: 'boolean' },
      ],
    };
    expect(mapTypeRef(union)).toBe('interface{}');
  });

  it('falls back to the first model variant when the mapping is empty', () => {
    const union: UnionType = { ...flagValueUnion(), discriminator: { property: 'value_type', mapping: {} } };
    prime(modelsWith(union));
    expect(mapTypeRef(union)).toBe('*FlagValue');
  });

  it('falls back to the first model variant when no wrapper was generated', () => {
    // An emitter entry point that runs without prepareGoUnions must not name a
    // wrapper type that was never written to unions.go.
    prime([]);
    expect(mapTypeRef(flagValueUnion())).toBe('*FlagValue');
  });
});

describe('go/unions — emitted wrapper', () => {
  it('emits a wrapper instead of throwing when a shared field conflicts across variants', () => {
    // `value` is boolean | string | number — the flat-superset flatten rejects
    // this outright, so reaching a wrapper at all is the regression guard.
    const files = emit(modelsWith(flagValueUnion()));
    expect(files.has('unions.go')).toBe(true);
    expect(files.get('models.go')).toContain('Value *FlagValueUnion `json:"value"`');
  });

  it('gives every variant its own typed field', () => {
    const go = emit(modelsWith(flagValueUnion())).get('unions.go')!;
    expect(go).toContain('type FlagValueUnion struct {');
    expect(go).toContain('ValueType FlagValueUnionValueType `json:"value_type"`');
    expect(go).toContain('Boolean *FlagValue `json:"-"`');
    expect(go).toContain('String *StringFlagValue `json:"-"`');
    expect(go).toContain('Number *NumberFlagValue `json:"-"`');
  });

  it('emits discriminator constants for every mapped value', () => {
    const go = emit(modelsWith(flagValueUnion())).get('unions.go')!;
    expect(go).toContain('type FlagValueUnionValueType string');
    expect(go).toContain('FlagValueUnionValueTypeBoolean FlagValueUnionValueType = "boolean"');
    expect(go).toContain('FlagValueUnionValueTypeString FlagValueUnionValueType = "string"');
    expect(go).toContain('FlagValueUnionValueTypeNumber FlagValueUnionValueType = "number"');
  });

  it('emits a typed accessor per variant', () => {
    const go = emit(modelsWith(flagValueUnion())).get('unions.go')!;
    expect(go).toContain('func (u FlagValueUnion) AsBoolean() (*FlagValue, bool) {');
    expect(go).toContain('func (u FlagValueUnion) AsString() (*StringFlagValue, bool) {');
    expect(go).toContain('func (u FlagValueUnion) AsNumber() (*NumberFlagValue, bool) {');
  });

  it('dispatches UnmarshalJSON on the discriminator', () => {
    const go = emit(modelsWith(flagValueUnion())).get('unions.go')!;
    expect(go).toContain('func (u *FlagValueUnion) UnmarshalJSON(data []byte) error {');
    expect(go).toContain('Value FlagValueUnionValueType `json:"value_type"`');
    expect(go).toContain('switch discriminator.Value {');
    // Each arm decodes into its own variant struct, so a string payload can
    // never be decoded into the boolean variant.
    expect(go).toContain('case FlagValueUnionValueTypeString:\n\t\tvar v StringFlagValue');
    expect(go).toContain('case FlagValueUnionValueTypeNumber:\n\t\tvar v NumberFlagValue');
  });

  it('emits a MarshalJSON that encodes the selected variant', () => {
    const go = emit(modelsWith(flagValueUnion())).get('unions.go')!;
    expect(go).toContain('func (u FlagValueUnion) MarshalJSON() ([]byte, error) {');
    expect(go).toContain('return json.Marshal(u.String)');
    // An unrecognized discriminator replays the original payload rather than
    // silently dropping it.
    expect(go).toContain('if len(u.raw) > 0 {');
  });

  it('imports encoding/json exactly once', () => {
    const go = emit(modelsWith(flagValueUnion())).get('unions.go')!;
    expect(go.match(/import "encoding\/json"/g)).toHaveLength(1);
    expect(go.startsWith('package workos\n')).toBe(true);
  });

  it('emits the wrapper shape for a single-member union', () => {
    const go = emit(modelsWith(singleMemberUnion())).get('unions.go')!;
    expect(go).toContain('type SettingTargetUnion struct {');
    expect(go).toContain('Organization *SettingTarget `json:"-"`');
    expect(go).toContain('SettingTargetUnionTypeOrganization SettingTargetUnionType = "organization"');
    expect(go).toContain('func (u SettingTargetUnion) AsOrganization() (*SettingTarget, bool) {');
    expect(go).toContain('func (u *SettingTargetUnion) UnmarshalJSON(data []byte) error {');
  });

  it('still emits every variant model as its own struct', () => {
    const models = emit(modelsWith(flagValueUnion())).get('models.go')!;
    expect(models).toContain('type FlagValue struct {');
    expect(models).toContain('type StringFlagValue struct {');
    expect(models).toContain('type NumberFlagValue struct {');
    // The variant-specific field types survive — the whole point of the wrapper.
    expect(models).toContain('Value bool `json:"value"`');
    expect(models).toContain('Value string `json:"value"`');
    expect(models).toContain('Value float64 `json:"value"`');
  });

  it('emits no unions.go when the spec has no discriminated unions', () => {
    const files = emit([
      { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
    ]);
    expect(files.has('unions.go')).toBe(false);
    expect(files.has('models.go')).toBe(true);
  });
});

describe('go/unions — collection', () => {
  it('deduplicates a union referenced from several fields', () => {
    const models: Model[] = [
      { name: 'A', fields: [{ name: 'value', type: flagValueUnion(), required: true }] },
      { name: 'B', fields: [{ name: 'value', type: flagValueUnion(), required: true }] },
      ...variantModels(),
    ];
    expect(prime(models)).toEqual(['FlagValueUnion']);
  });

  it('finds unions nested in arrays and nullables', () => {
    const nested: TypeRef = { kind: 'array', items: { kind: 'nullable', inner: flagValueUnion() } };
    expect(prime(modelsWith(nested))).toEqual(['FlagValueUnion']);
  });

  it('drops an arm whose variant model will not be emitted', () => {
    const models = modelsWith(flagValueUnion()).filter((m) => m.name !== 'NumberFlagValue');
    const ctx = contextFor(models);
    const unions = prepareGoUnions(models, ctx.spec.enums, emittableModelPredicate(models, ctx));
    expect(unions[0].arms.map((a) => a.value)).toEqual(['boolean', 'string']);
  });

  it('ignores a mapping entry that is not one of the union variants', () => {
    const union: UnionType = {
      ...flagValueUnion(),
      discriminator: {
        property: 'value_type',
        mapping: { boolean: 'FlagValue', elsewhere: 'SomeUnrelatedModel' },
      },
    };
    const models = modelsWith(union);
    const ctx = contextFor(models);
    const unions = prepareGoUnions(models, ctx.spec.enums, emittableModelPredicate(models, ctx));
    expect(unions[0].arms.map((a) => a.goType)).toEqual(['FlagValue']);
  });

  it('wraps neither union when two distinct ones would claim the same name', () => {
    // The per-operation `Error400` shape: many unrelated unions whose leading
    // variant shares a name. Picking a winner would give the loser the wrong
    // variants, so both keep the first-variant collapse.
    const other: UnionType = {
      kind: 'union',
      compositionKind: 'oneOf',
      discriminator: { property: 'value_type', mapping: { boolean: 'FlagValue' } },
      variants: [{ kind: 'model', name: 'FlagValue' }],
    };
    const models: Model[] = [
      { name: 'A', fields: [{ name: 'value', type: flagValueUnion(), required: true }] },
      { name: 'B', fields: [{ name: 'value', type: other, required: true }] },
      ...variantModels(),
    ];
    expect(prime(models)).toEqual([]);
    expect(mapTypeRef(flagValueUnion())).toBe('*FlagValue');
  });

  it('skips a wrapper whose name collides with an existing model', () => {
    const models = [...modelsWith(flagValueUnion()), { name: 'FlagValueUnion', fields: [] }];
    expect(prime(models)).toEqual([]);
  });

  it('ignores discriminated unions that are not on a model field', () => {
    // Operation-level error unions keep collapsing to their first variant.
    const models = variantModels();
    const ctx = contextFor(models);
    ctx.spec.services = [
      {
        name: 'Flags',
        operations: [
          {
            name: 'get',
            httpMethod: 'get',
            path: '/flags',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: flagValueUnion(),
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    expect(prepareGoUnions(models, ctx.spec.enums, emittableModelPredicate(models, ctx))).toEqual([]);
  });
});

describe('go/unions — golden output', () => {
  it('renders the full wrapper for a multi-member union with a conflicting shared field', () => {
    expect(emit(modelsWith(flagValueUnion())).get('unions.go')).toMatchInlineSnapshot(`
      "package workos

      import "encoding/json"

      // FlagValueUnion is a discriminated union: exactly one variant pointer is set,
      // and ValueType says which. Use the As* accessors to read a variant safely.
      type FlagValueUnion struct {
      	// ValueType identifies which variant this union holds.
      	ValueType FlagValueUnionValueType \`json:"value_type"\`
      	// Boolean is set when ValueType is FlagValueUnionValueTypeBoolean.
      	Boolean *FlagValue \`json:"-"\`
      	// String is set when ValueType is FlagValueUnionValueTypeString.
      	String *StringFlagValue \`json:"-"\`
      	// Number is set when ValueType is FlagValueUnionValueTypeNumber.
      	Number *NumberFlagValue \`json:"-"\`

      	// raw retains the payload as received so an unrecognized discriminator
      	// value survives an unmarshal/marshal round trip instead of being dropped.
      	raw json.RawMessage
      }

      // FlagValueUnionValueType identifies the variant held by a FlagValueUnion.
      type FlagValueUnionValueType string

      const (
      	// FlagValueUnionValueTypeBoolean selects the FlagValue variant.
      	FlagValueUnionValueTypeBoolean FlagValueUnionValueType = "boolean"
      	// FlagValueUnionValueTypeString selects the StringFlagValue variant.
      	FlagValueUnionValueTypeString FlagValueUnionValueType = "string"
      	// FlagValueUnionValueTypeNumber selects the NumberFlagValue variant.
      	FlagValueUnionValueTypeNumber FlagValueUnionValueType = "number"
      )

      // AsBoolean returns the FlagValue variant and reports whether it is set.
      func (u FlagValueUnion) AsBoolean() (*FlagValue, bool) {
      	return u.Boolean, u.Boolean != nil
      }

      // AsString returns the StringFlagValue variant and reports whether it is set.
      func (u FlagValueUnion) AsString() (*StringFlagValue, bool) {
      	return u.String, u.String != nil
      }

      // AsNumber returns the NumberFlagValue variant and reports whether it is set.
      func (u FlagValueUnion) AsNumber() (*NumberFlagValue, bool) {
      	return u.Number, u.Number != nil
      }

      // UnmarshalJSON decodes the payload into the variant selected by the
      // "value_type" discriminator. An unrecognized value leaves every
      // variant nil; ValueType still reports what the wire said.
      func (u *FlagValueUnion) UnmarshalJSON(data []byte) error {
      	var discriminator struct {
      		Value FlagValueUnionValueType \`json:"value_type"\`
      	}
      	if err := json.Unmarshal(data, &discriminator); err != nil {
      		return err
      	}

      	*u = FlagValueUnion{ValueType: discriminator.Value, raw: append(json.RawMessage(nil), data...)}

      	switch discriminator.Value {
      	case FlagValueUnionValueTypeBoolean:
      		var v FlagValue
      		if err := json.Unmarshal(data, &v); err != nil {
      			return err
      		}
      		u.Boolean = &v
      	case FlagValueUnionValueTypeString:
      		var v StringFlagValue
      		if err := json.Unmarshal(data, &v); err != nil {
      			return err
      		}
      		u.String = &v
      	case FlagValueUnionValueTypeNumber:
      		var v NumberFlagValue
      		if err := json.Unmarshal(data, &v); err != nil {
      			return err
      		}
      		u.Number = &v
      	}

      	return nil
      }

      // MarshalJSON encodes the variant selected by ValueType.
      func (u FlagValueUnion) MarshalJSON() ([]byte, error) {
      	switch u.ValueType {
      	case FlagValueUnionValueTypeBoolean:
      		if u.Boolean != nil {
      			return json.Marshal(u.Boolean)
      		}
      	case FlagValueUnionValueTypeString:
      		if u.String != nil {
      			return json.Marshal(u.String)
      		}
      	case FlagValueUnionValueTypeNumber:
      		if u.Number != nil {
      			return json.Marshal(u.Number)
      		}
      	}

      	// No variant set: replay the original payload when we have one, so a
      	// value produced by UnmarshalJSON always round trips.
      	if len(u.raw) > 0 {
      		return u.raw, nil
      	}
      	if u.ValueType == "" {
      		return []byte("null"), nil
      	}
      	return json.Marshal(map[string]string{"value_type": string(u.ValueType)})
      }
      "
    `);
  });

  it('renders the full wrapper for a single-member union', () => {
    expect(emit(modelsWith(singleMemberUnion())).get('unions.go')).toMatchInlineSnapshot(`
      "package workos

      import "encoding/json"

      // SettingTargetUnion is a discriminated union: exactly one variant pointer is set,
      // and Type says which. Use the As* accessors to read a variant safely.
      type SettingTargetUnion struct {
      	// Type identifies which variant this union holds.
      	Type SettingTargetUnionType \`json:"type"\`
      	// Organization is set when Type is SettingTargetUnionTypeOrganization.
      	Organization *SettingTarget \`json:"-"\`

      	// raw retains the payload as received so an unrecognized discriminator
      	// value survives an unmarshal/marshal round trip instead of being dropped.
      	raw json.RawMessage
      }

      // SettingTargetUnionType identifies the variant held by a SettingTargetUnion.
      type SettingTargetUnionType string

      const (
      	// SettingTargetUnionTypeOrganization selects the SettingTarget variant.
      	SettingTargetUnionTypeOrganization SettingTargetUnionType = "organization"
      )

      // AsOrganization returns the SettingTarget variant and reports whether it is set.
      func (u SettingTargetUnion) AsOrganization() (*SettingTarget, bool) {
      	return u.Organization, u.Organization != nil
      }

      // UnmarshalJSON decodes the payload into the variant selected by the
      // "type" discriminator. An unrecognized value leaves every
      // variant nil; Type still reports what the wire said.
      func (u *SettingTargetUnion) UnmarshalJSON(data []byte) error {
      	var discriminator struct {
      		Value SettingTargetUnionType \`json:"type"\`
      	}
      	if err := json.Unmarshal(data, &discriminator); err != nil {
      		return err
      	}

      	*u = SettingTargetUnion{Type: discriminator.Value, raw: append(json.RawMessage(nil), data...)}

      	switch discriminator.Value {
      	case SettingTargetUnionTypeOrganization:
      		var v SettingTarget
      		if err := json.Unmarshal(data, &v); err != nil {
      			return err
      		}
      		u.Organization = &v
      	}

      	return nil
      }

      // MarshalJSON encodes the variant selected by Type.
      func (u SettingTargetUnion) MarshalJSON() ([]byte, error) {
      	switch u.Type {
      	case SettingTargetUnionTypeOrganization:
      		if u.Organization != nil {
      			return json.Marshal(u.Organization)
      		}
      	}

      	// No variant set: replay the original payload when we have one, so a
      	// value produced by UnmarshalJSON always round trips.
      	if len(u.raw) > 0 {
      		return u.raw, nil
      	}
      	if u.Type == "" {
      		return []byte("null"), nil
      	}
      	return json.Marshal(map[string]string{"type": string(u.Type)})
      }
      "
    `);
  });
});

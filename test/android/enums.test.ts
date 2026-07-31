import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Enum } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateEnums } from '../../src/android/enums.js';

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

describe('android/enums', () => {
  it('returns empty for no enums', () => {
    expect(generateEnums([], ctx)).toEqual([]);
  });

  it('generates a forward-compatible sealed class with a generated serializer', () => {
    const enums: Enum[] = [
      {
        name: 'ConnectionState',
        values: [
          { name: 'active', value: 'active' },
          { name: 'inactive', value: 'inactive' },
        ],
      },
    ];
    const files = generateEnums(enums, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/main/kotlin/com/workos/android/enums/ConnectionState.kt');
    const content = files[0].content;
    expect(content).toContain('@Serializable(with = ConnectionState.Serializer::class)');
    expect(content).toContain('public sealed class ConnectionState(public val rawValue: String) {');
    expect(content).toContain('public data object Active : ConnectionState("active")');
    expect(content).toContain('public data object Inactive : ConnectionState("inactive")');
    // the unknown carrier preserves the raw wire value so round-trips are lossless
    expect(content).toContain('public data class Unknown(public val value: String) : ConnectionState(value)');
    expect(content).toContain('public fun fromRawValue(rawValue: String): ConnectionState =');
    expect(content).toContain('else -> Unknown(rawValue)');
    expect(content).toContain('public val allKnownValues: List<ConnectionState> = listOf(Active, Inactive)');
    // an explicit serializer, not implicit conformance
    expect(content).toContain('internal object Serializer : KSerializer<ConnectionState> {');
    expect(content).toContain('PrimitiveSerialDescriptor("ConnectionState", PrimitiveKind.STRING)');
    expect(content).toContain('encoder.encodeString(value.rawValue)');
  });

  it('uses Int raw values for numeric enums', () => {
    const enums: Enum[] = [
      {
        name: 'Level',
        values: [
          { name: 'one', value: 1 },
          { name: 'two', value: 2 },
        ],
      },
    ];
    const content = generateEnums(enums, ctx)[0].content;
    expect(content).toContain('public sealed class Level(public val rawValue: Int) {');
    expect(content).toContain('public data object One : Level(1)');
    expect(content).toContain('PrimitiveKind.INT');
    expect(content).toContain('decoder.decodeInt()');
    expect(content).toContain('encoder.encodeInt(value.rawValue)');
  });

  it('suffixes a wire value that collides with the reserved Unknown sentinel', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [
          { name: 'unknown', value: 'unknown' },
          { name: 'active', value: 'active' },
        ],
      },
    ];
    const content = generateEnums(enums, ctx)[0].content;
    // the real `unknown` wire value becomes Unknown2; the sentinel keeps `Unknown`
    expect(content).toContain('public data object Unknown2 : Status("unknown")');
    expect(content).toContain('public data class Unknown(public val value: String) : Status(value)');
  });

  it('prefixes numeric-leading values so the object name is a valid identifier', () => {
    const enums: Enum[] = [{ name: 'Version', values: [{ name: '2fa', value: '2fa' }] }];
    const content = generateEnums(enums, ctx)[0].content;
    expect(content).toMatch(/public data object Value\w* : Version\("2fa"\)/);
  });

  it('escapes `$` in wire values so they cannot become Kotlin string templates', () => {
    const enums: Enum[] = [
      {
        name: 'Status',
        values: [
          { name: 'active', value: 'active' },
          { name: 'evil', value: '${System.getenv()}' },
        ],
      },
    ];
    const content = generateEnums(enums, ctx)[0].content;
    expect(content).toContain('\\${System.getenv()}');
    expect(content).not.toMatch(/[^\\]\$\{System\.getenv\(\)\}/);
  });

  it('handles a value-less enum without emitting an empty `when`', () => {
    const content = generateEnums([{ name: 'Empty', values: [] }], ctx)[0].content;
    expect(content).toContain('public val allKnownValues: List<Empty> = emptyList()');
    expect(content).toContain('Unknown(rawValue)');
    expect(content).not.toContain('when (rawValue) {');
  });

  it('marks deprecated values with @Deprecated', () => {
    const enums: Enum[] = [{ name: 'Status', values: [{ name: 'old', value: 'old', deprecated: true }] }];
    expect(generateEnums(enums, ctx)[0].content).toContain('@Deprecated(');
  });
});

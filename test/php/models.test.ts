import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { generateModels } from '../../src/php/models.js';

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

/** Find the model file for a given class name (skipping the trait file). */
function findModel(result: ReturnType<typeof generateModels>, name: string) {
  return result.find((f) => f.path === `lib/Resource/${name}.php`);
}

describe('generateModels', () => {
  it('returns empty array for no models', () => {
    expect(generateModels([], ctx)).toEqual([]);
  });

  it('generates a readonly class with constructor promotion', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'slug', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'Organization');
    expect(file).toBeDefined();
    expect(file!.content).toContain('readonly class Organization');
    expect(file!.content).toContain('public string $id,');
    expect(file!.content).toContain('public string $name,');
    expect(file!.content).toContain('public ?string $slug = null,');
    expect(file!.content).toContain('public static function fromArray(array $data): self');
    expect(file!.content).toContain('public function toArray(): array');
    expect(file!.content).toContain('implements \\JsonSerializable');
    expect(file!.content).toContain('use JsonSerializableTrait;');
  });

  it('generates JsonSerializableTrait file', () => {
    const models: Model[] = [
      {
        name: 'Item',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const trait = result.find((f) => f.path === 'lib/Resource/JsonSerializableTrait.php');
    expect(trait).toBeDefined();
    expect(trait!.content).toContain('trait JsonSerializableTrait');
    expect(trait!.content).toContain('return $this->toArray();');
  });

  it('handles required date-time fields without fallback', () => {
    const models: Model[] = [
      {
        name: 'Event',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'Event');
    expect(file).toBeDefined();
    expect(file!.content).toContain('\\DateTimeImmutable $createdAt');
    expect(file!.content).toContain("new \\DateTimeImmutable($data['created_at'])");
    expect(file!.content).not.toContain("?? 'now'");
  });

  it('handles optional date-time fields with isset guard and no fallback', () => {
    const models: Model[] = [
      {
        name: 'Session',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'last_sign_in_at',
            type: { kind: 'primitive', type: 'string', format: 'date-time' },
            required: false,
          },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'Session');
    expect(file).toBeDefined();
    expect(file!.content).toContain(
      "isset($data['last_sign_in_at']) ? new \\DateTimeImmutable($data['last_sign_in_at']) : null",
    );
    expect(file!.content).not.toContain("?? 'now'");
  });

  it('handles enum fields with ::from() not ::tryFrom()', () => {
    const models: Model[] = [
      {
        name: 'Connection',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'status', type: { kind: 'enum', name: 'ConnectionStatus' }, required: true },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'Connection');
    expect(file).toBeDefined();
    expect(file!.content).toContain("ConnectionStatus::from($data['status'])");
    expect(file!.content).not.toContain('tryFrom');
  });

  it('handles model references in fromArray', () => {
    const models: Model[] = [
      {
        name: 'User',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'profile', type: { kind: 'model', name: 'Profile' }, required: false },
        ],
      },
      {
        name: 'Profile',
        fields: [{ name: 'bio', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const userFile = findModel(result, 'User');
    expect(userFile).toBeDefined();
    expect(userFile!.content).toContain('Profile::fromArray');
  });

  it('handles required nullable model fields with isset guard', () => {
    const models: Model[] = [
      {
        name: 'FeatureFlag',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'owner',
            type: { kind: 'nullable', inner: { kind: 'model', name: 'Owner' } },
            required: true,
          },
        ],
      },
      {
        name: 'Owner',
        fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const flagFile = findModel(result, 'FeatureFlag');
    expect(flagFile).toBeDefined();
    expect(flagFile!.content).toContain("isset($data['owner']) ? Owner::fromArray($data['owner']) : null");
  });

  it('skips list wrapper models', () => {
    const models: Model[] = [
      {
        name: 'OrganizationList',
        fields: [
          {
            name: 'data',
            type: { kind: 'array', items: { kind: 'model', name: 'Organization' } },
            required: true,
          },
          {
            name: 'list_metadata',
            type: { kind: 'model', name: 'ListMetadata' },
            required: true,
          },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    // Only the trait file should be present — no model files
    const modelFiles = result.filter((f) => !f.path.includes('Trait'));
    expect(modelFiles).toHaveLength(0);
  });

  it('skips prefixed list metadata models like ApiKeyListListMetadata', () => {
    const models: Model[] = [
      {
        name: 'ApiKeyListListMetadata',
        fields: [
          { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
          { name: 'before', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    // Only the trait file should be present — no model files
    const modelFiles = result.filter((f) => !f.path.includes('Trait'));
    expect(modelFiles).toHaveLength(0);
  });

  it('generates correct namespace', () => {
    const models: Model[] = [
      {
        name: 'Item',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'Item');
    expect(file).toBeDefined();
    expect(file!.content).toContain('namespace WorkOS\\Resource;');
  });

  it('adds PHPDoc @deprecated for deprecated fields', () => {
    const models: Model[] = [
      {
        name: 'Connection',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'old_field', type: { kind: 'primitive', type: 'string' }, required: false, deprecated: true },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'Connection');
    expect(file).toBeDefined();
    expect(file!.content).toContain('/** @deprecated */');
    // The deprecated PHPDoc should come before the property
    const lines = file!.content.split('\n');
    const deprecatedIdx = lines.findIndex((l: string) => l.includes('@deprecated'));
    const propertyIdx = lines.findIndex((l: string) => l.includes('$oldField'));
    expect(deprecatedIdx).toBeGreaterThan(-1);
    expect(propertyIdx).toBeGreaterThan(-1);
    expect(deprecatedIdx).toBeLessThan(propertyIdx);
  });

  it('adds PHPDoc with description and @deprecated for fields', () => {
    const models: Model[] = [
      {
        name: 'Connection',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'legacy_name',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            description: 'Use name instead',
            deprecated: true,
          },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'Connection');
    expect(file).toBeDefined();
    expect(file!.content).toContain('Use name instead');
    expect(file!.content).toContain('@deprecated');
  });

  it('adds @var PHPDoc for array-typed properties', () => {
    const models: Model[] = [
      {
        name: 'Connection',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'domains',
            type: { kind: 'array', items: { kind: 'model', name: 'ConnectionDomain' } },
            required: true,
          },
        ],
      },
      {
        name: 'ConnectionDomain',
        fields: [{ name: 'domain', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'Connection');
    expect(file).toBeDefined();
    expect(file!.content).toContain('@var array<\\WorkOS\\Resource\\ConnectionDomain>');
  });

  it('adds @var PHPDoc for nullable array-typed properties', () => {
    const models: Model[] = [
      {
        name: 'User',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'roles',
            type: { kind: 'nullable', inner: { kind: 'array', items: { kind: 'primitive', type: 'string' } } },
            required: false,
          },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'User');
    expect(file).toBeDefined();
    expect(file!.content).toContain('@var array<string>|null');
  });
});

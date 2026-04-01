import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { generateModels } from '../../src/php/models.js';
import { initializeNaming } from '../../src/php/naming.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'workos',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

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
    initializeNaming(models.map((m) => m.name));
    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('lib/Resource/Organization.php');
    expect(result[0].content).toContain('readonly class Organization');
    expect(result[0].content).toContain('public string $id,');
    expect(result[0].content).toContain('public string $name,');
    expect(result[0].content).toContain('public ?string $slug = null,');
    expect(result[0].content).toContain('public static function fromArray(array $data): static');
    expect(result[0].content).toContain('public function toArray(): array');
    expect(result[0].content).toContain('implements \\JsonSerializable');
  });

  it('handles date-time fields with DateTimeImmutable', () => {
    const models: Model[] = [
      {
        name: 'Event',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
        ],
      },
    ];
    initializeNaming(models.map((m) => m.name));
    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    expect(result[0].content).toContain('\\DateTimeImmutable $createdAt');
    expect(result[0].content).toContain("new \\DateTimeImmutable($data['created_at'])");
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
    initializeNaming(models.map((m) => m.name));
    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const userFile = result.find((f) => f.path.includes('User.php'));
    expect(userFile).toBeDefined();
    expect(userFile!.content).toContain('Profile::fromArray');
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
    initializeNaming(models.map((m) => m.name));
    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    expect(result).toHaveLength(0);
  });

  it('generates correct namespace', () => {
    const models: Model[] = [
      {
        name: 'Item',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];
    initializeNaming(models.map((m) => m.name));
    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    expect(result[0].content).toContain('namespace WorkOS\\Resource;');
  });
});

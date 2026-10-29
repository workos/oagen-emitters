import { describe, it, expect } from 'vitest';
import type { EmitterContext, ApiSpec, Model } from '@workos/oagen';
import { defaultSdkBehavior } from '@workos/oagen';
import { spawnSync } from 'node:child_process';
import { generateModels } from '../../src/php/models.js';
import { generateRuntime } from '../../src/php/runtime.js';

const hasPhp = spawnSync('php', ['--version'], { timeout: 5000 }).status === 0;

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

  it('hydrates optional array-of-model fields via array_map in fromArray', () => {
    const models: Model[] = [
      {
        name: 'DirectoryUser',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'emails',
            type: { kind: 'array', items: { kind: 'model', name: 'DirectoryUserEmail' } },
            required: false,
          },
        ],
      },
      {
        name: 'DirectoryUserEmail',
        fields: [{ name: 'value', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'DirectoryUser');
    expect(file).toBeDefined();
    // fromArray should use isset guard + array_map for optional array-of-model
    expect(file!.content).toContain(
      "isset($data['emails']) ? array_map(fn ($item) => DirectoryUserEmail::fromArray($item), $data['emails']) : null",
    );
    // toArray should call ->toArray() on each item
    expect(file!.content).toContain(
      '$this->emails !== null ? array_map(fn ($item) => $item->toArray(), $this->emails) : null',
    );
  });

  it('hydrates optional array-of-enum fields via array_map in fromArray', () => {
    const models: Model[] = [
      {
        name: 'Profile',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'roles',
            type: { kind: 'array', items: { kind: 'enum', name: 'RoleType' } },
            required: false,
          },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'Profile');
    expect(file).toBeDefined();
    expect(file!.content).toContain(
      "isset($data['roles']) ? array_map(fn ($item) => RoleType::from($item), $data['roles']) : null",
    );
    expect(file!.content).toContain(
      '$this->roles !== null ? array_map(fn ($item) => $item->value, $this->roles) : null',
    );
  });

  it('uses nullsafe operator for nullable enum in toArray', () => {
    const models: Model[] = [
      {
        name: 'Connection',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'status', type: { kind: 'enum', name: 'ConnectionStatus' }, required: false },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'Connection');
    expect(file).toBeDefined();
    expect(file!.content).toContain('$this->status?->value');
    expect(file!.content).not.toContain('instanceof \\BackedEnum');
  });

  it('emits all structurally identical models as full classes', () => {
    const models: Model[] = [
      {
        name: 'FlagCreatedContextActor',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'type', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
      {
        name: 'FlagUpdatedContextActor',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'type', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
      {
        name: 'FlagDeletedContextActor',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'type', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    // PHP readonly classes cannot be aliased, so all models are emitted as full classes
    const modelFiles = result.filter((f) => !f.path.includes('Trait'));
    expect(modelFiles).toHaveLength(3);
    expect(modelFiles[0].path).toContain('FlagCreatedContextActor');
    expect(modelFiles[1].path).toContain('FlagUpdatedContextActor');
    expect(modelFiles[2].path).toContain('FlagDeletedContextActor');
  });

  it('does not produce double |null in @var for nullable optional arrays', () => {
    const models: Model[] = [
      {
        name: 'User',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'tags',
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
    expect(file!.content).not.toContain('|null|null');
  });

  it('emits ->toArray() for polymorphic union of model variants', () => {
    const models: Model[] = [
      {
        name: 'ApiKey',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'owner',
            type: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'ApiKeyOwner' },
                { kind: 'model', name: 'UserApiKeyOwner' },
              ],
              discriminator: {
                property: 'type',
                mapping: { apiKey: 'ApiKeyOwner', user: 'UserApiKeyOwner' },
              },
            },
            required: true,
          },
        ],
      },
      {
        name: 'ApiKeyOwner',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'UserApiKeyOwner',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    const result = generateModels(models, { ...ctx, spec: specWithModels });

    const file = findModel(result, 'ApiKey');
    expect(file).toBeDefined();
    // toArray must dispatch to the concrete instance, not emit the bare object.
    expect(file!.content).toContain("'owner' => $this->owner->toArray()");
    expect(file!.content).not.toMatch(/'owner' => \$this->owner,/);
    // fromArray match on discriminator must throw on unknown values, not pass through raw.
    expect(file!.content).toContain("match ($data['owner']['type'] ?? null)");
    expect(file!.content).toContain('throw new \\UnexpectedValueException');
    expect(file!.content).not.toMatch(/default => \$data\['owner'\]/);
  });

  it('throws at codegen time for heterogeneous union mixing model and scalar', () => {
    const models: Model[] = [
      {
        name: 'Thing',
        fields: [
          {
            name: 'value',
            type: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'SomeModel' },
                { kind: 'primitive', type: 'string' },
              ],
            },
            required: true,
          },
        ],
      },
      {
        name: 'SomeModel',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
    ];

    const specWithModels = { ...emptySpec, models };
    expect(() => generateModels(models, { ...ctx, spec: specWithModels })).toThrow(
      /heterogeneous union.*model:SomeModel \| primitive/,
    );
  });
});

describe('generateModels date-time serialization', () => {
  // oagen-emitters#293: every date-time a model writes back — a required
  // field, an optional one, an array of them — goes through the one generated
  // helper, so a model never sends an offset the API rejects.
  const models: Model[] = [
    {
      name: 'Session',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
        { name: 'ended_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: false },
        {
          name: 'seen_at',
          type: { kind: 'array', items: { kind: 'primitive', type: 'string', format: 'date-time' } },
          required: false,
        },
      ],
    },
  ];
  const specWithModels = { ...emptySpec, models };
  const result = generateModels(models, { ...ctx, spec: specWithModels });
  const content = findModel(result, 'Session')!.content;

  it('routes required, optional and array date-time fields through DateTimeFormat::iso8601', () => {
    expect(content).toContain("'created_at' => \\WorkOS\\Internal\\DateTimeFormat::iso8601($this->createdAt),");
    expect(content).toContain("'ended_at' => \\WorkOS\\Internal\\DateTimeFormat::iso8601($this->endedAt),");
    expect(content).toContain(
      "'seen_at' => $this->seenAt !== null ? array_map(fn ($item) => \\WorkOS\\Internal\\DateTimeFormat::iso8601($item), $this->seenAt) : null,",
    );
    expect(content).not.toContain('RFC3339_EXTENDED');
  });

  it.skipIf(!hasPhp)('serializes the model to UTC Z strings, null and arrays alike, in PHP', () => {
    const program = `<?php
declare(strict_types=1);
${generateRuntime({ ...ctx, spec: specWithModels })
  .map((f) => f.content)
  .join('\n')}
${result.map((f) => f.content).join('\n')}
namespace WorkOS;
$session = new \\WorkOS\\Resource\\Session(
    id: 'session_01',
    createdAt: new \\DateTimeImmutable('2025-01-01T02:00:00+02:00'),
    seenAt: [new \\DateTimeImmutable('2023-01-01T00:00:00.123456Z'), new \\DateTimeImmutable('2024-06-01T12:30:00-05:00')],
);
$roundTrip = \\WorkOS\\Resource\\Session::fromArray(['id' => 'session_02', 'created_at' => '2025-01-01T00:00:00.000Z']);
echo json_encode([$session->toArray(), $roundTrip->toArray()], JSON_THROW_ON_ERROR);
`;
    const run = spawnSync('php', ['-n'], { input: program, encoding: 'utf8', timeout: 15000 });
    expect(run.stderr).toBe('');
    expect(run.status, run.stdout || run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      {
        id: 'session_01',
        created_at: '2025-01-01T00:00:00.000Z',
        ended_at: null,
        seen_at: ['2023-01-01T00:00:00.123Z', '2024-06-01T17:30:00.000Z'],
      },
      { id: 'session_02', created_at: '2025-01-01T00:00:00.000Z', ended_at: null, seen_at: null },
    ]);
  });
});

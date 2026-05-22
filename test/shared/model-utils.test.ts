import { describe, expect, it } from 'vitest';
import type { Model } from '@workos/oagen';
import {
  collectReferencedListMetadataModels,
  isListMetadataModel,
  isListWrapperModel,
} from '../../src/shared/model-utils.js';

const listMetadataModel: Model = {
  name: 'ListMetadata',
  fields: [
    {
      name: 'before',
      type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
      required: false,
    },
    {
      name: 'after',
      type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
      required: false,
    },
  ],
};

describe('isListMetadataModel', () => {
  it('matches a two-field nullable-string before/after shape', () => {
    expect(isListMetadataModel(listMetadataModel)).toBe(true);
  });
});

describe('collectReferencedListMetadataModels', () => {
  it('returns nothing when no surviving wrapper references the model', () => {
    // A paginated list wrapper that the SDK pagination machinery unwraps —
    // not in `nonPaginatedRefs`, so it counts as skipped.
    const paginatedWrapper: Model = {
      name: 'OrgList',
      fields: [
        { name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'Org' } }, required: true },
        { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
      ],
    };
    const result = collectReferencedListMetadataModels([listMetadataModel, paginatedWrapper], new Set());
    expect(result.size).toBe(0);
  });

  it('flags the ListMetadata model when a non-paginated wrapper still references it', () => {
    // `VersionListResponse` is shaped like a list envelope but the operation
    // has no pagination params, so it survives the wrapper skip — and its
    // `list_metadata` field needs the `ListMetadata` interface on disk.
    const versionWrapper: Model = {
      name: 'VersionListResponse',
      fields: [
        { name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'Version' } }, required: true },
        { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
      ],
    };
    const result = collectReferencedListMetadataModels(
      [listMetadataModel, versionWrapper],
      new Set(['VersionListResponse']),
    );
    expect(result.has('ListMetadata')).toBe(true);
  });

  it('flags the ListMetadata model when a non-wrapper IR model references it directly', () => {
    // Defensive: should anything else point at a `ListMetadata`-shape model
    // as a regular field, we still need the file.
    const customModel: Model = {
      name: 'Custom',
      fields: [{ name: 'meta', type: { kind: 'model', name: 'ListMetadata' }, required: true }],
    };
    const result = collectReferencedListMetadataModels([listMetadataModel, customModel], new Set());
    expect(result.has('ListMetadata')).toBe(true);
  });

  it('returns an empty set when no ListMetadata-shape model exists in the IR', () => {
    const regular: Model = {
      name: 'Foo',
      fields: [{ name: 'bar', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const result = collectReferencedListMetadataModels([regular], new Set());
    expect(result.size).toBe(0);
  });
});

describe('isListWrapperModel + isListMetadataModel — sanity', () => {
  it('does not classify a wrapper as a metadata model', () => {
    const wrapper: Model = {
      name: 'OrgList',
      fields: [
        { name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'Org' } }, required: true },
        { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadata' }, required: true },
      ],
    };
    expect(isListWrapperModel(wrapper)).toBe(true);
    expect(isListMetadataModel(wrapper)).toBe(false);
  });
});

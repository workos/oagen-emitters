import { expect, it } from 'vitest';
import { preserveParameterOrder } from '../../src/shared/parameter-order.js';

it('keeps existing positional parameters, including request options, ahead of new optional parameters', () => {
  const parameters = [
    { name: 'id', optional: false },
    { name: 'intent', optional: true },
    { name: 'token', optional: true },
    { name: 'options', optional: true },
  ];
  const ordered = preserveParameterOrder(
    parameters,
    [{ name: 'id' }, { name: 'token' }, { name: 'options' }],
    (p) => p.name,
    (p) => p.optional,
  );
  expect(ordered.map((p) => p.name)).toEqual(['id', 'token', 'options', 'intent']);
  expect(parameters.map((p) => p.name)).toEqual(['id', 'intent', 'token', 'options']);
});

it('does not make new required inputs optional to retain an obsolete signature', () => {
  const parameters = [
    { name: 'organizationId', optional: false },
    { name: 'userId', optional: false },
    { name: 'token', optional: true },
  ];
  expect(
    preserveParameterOrder(
      parameters,
      [{ name: 'organizationId' }, { name: 'token' }],
      (p) => p.name,
      (p) => p.optional,
    ),
  ).toEqual(parameters);
  expect(
    preserveParameterOrder(
      parameters,
      undefined,
      (p) => p.name,
      (p) => p.optional,
    ),
  ).toBe(parameters);
});

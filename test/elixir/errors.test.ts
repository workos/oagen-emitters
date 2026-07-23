import { describe, it, expect } from 'vitest';
import { generateErrors } from '../../src/elixir/errors.js';
import { makeSpec, makeCtx } from './helpers.js';

describe('elixir/errors', () => {
  it('emits a single errors.ex with all error modules', () => {
    const files = generateErrors(makeCtx(makeSpec()));
    expect(files.map((f) => f.path)).toEqual(['lib/acme/errors.ex']);
    const content = files[0].content;
    expect(content).toContain('defmodule Acme.Error do');
    expect(content).toContain('defmodule Acme.ApiError do');
    expect(content).toContain('defmodule Acme.TransportError do');
    expect(content).toContain('defmodule Acme.ConfigurationError do');
  });

  it('derives the kind union from the error policy', () => {
    const [file] = generateErrors(makeCtx(makeSpec()));
    expect(file.content).toContain(':bad_request');
    expect(file.content).toContain(':authentication');
    expect(file.content).toContain(':not_found');
    expect(file.content).toContain(':rate_limit_exceeded');
    expect(file.content).toContain(':server');
    expect(file.content).toContain(':api');
  });

  it('declares the shared error union type', () => {
    const [file] = generateErrors(makeCtx(makeSpec()));
    expect(file.content).toContain('@type error :: Acme.ApiError.t() | Acme.TransportError.t()');
  });

  it('renders the error modules', () => {
    const [file] = generateErrors(makeCtx(makeSpec()));
    expect(file.content).toMatchInlineSnapshot(`
      "defmodule Acme.Error do
        @moduledoc """
        Union of the error values SDK functions can return in \`{:error, error}\` tuples.
        """

        @type error :: Acme.ApiError.t() | Acme.TransportError.t()
      end

      defmodule Acme.ApiError do
        @moduledoc """
        A non-2xx response from the API.

        The \`:kind\` field classifies the failure by status code (e.g. \`:not_found\`),
        so callers can pattern-match without memorizing status numbers.
        """

        defexception [:message, :status, :kind, :request_id, :code, :body]

        @type kind ::
                :bad_request
                | :authentication
                | :authorization
                | :not_found
                | :conflict
                | :unprocessable_entity
                | :rate_limit_exceeded
                | :server
                | :api

        @type t :: %__MODULE__{
                message: String.t(),
                status: pos_integer(),
                kind: kind(),
                request_id: String.t() | nil,
                code: String.t() | nil,
                body: map() | String.t() | nil
              }
      end

      defmodule Acme.TransportError do
        @moduledoc """
        A network-level failure (DNS, timeout, connection refused).
        """

        defexception [:message, :reason]

        @type t :: %__MODULE__{message: String.t(), reason: term()}
      end

      defmodule Acme.ConfigurationError do
        @moduledoc """
        Missing or invalid client configuration (e.g. no API key). Raised from
        \`Acme.Client.new/1\` — configuration problems are programmer errors, not
        runtime failures.
        """

        defexception [:message]

        @type t :: %__MODULE__{message: String.t()}
      end"
    `);
  });
});

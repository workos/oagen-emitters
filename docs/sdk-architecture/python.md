# Python SDK Architecture

Fresh Scenario B design — no existing SDK to preserve.

## Architecture Overview

- **Main client**: `WorkOS` class with HTTP methods (`_request`, `get`, `post`, `put`, `patch`, `delete`) and resource accessors (e.g., `workos.organizations`).
- **Resource classes**: One per service, constructor receives `WorkOS` client, methods return deserialized dataclass instances.
- **Single type system**: Dataclasses with snake_case fields matching wire format — no separate domain/wire layers.
- **Deserialization**: `from_dict` class methods on dataclasses; `to_dict` instance methods for serialization.
- **Pagination**: `SyncPage[T]` with cursor-based `after` param, `auto_paging_iter()` generator.
- **Error hierarchy**: Status-code-specific exception classes extending base `WorkOSError`.
- **Constructor**: Accepts `api_key` keyword or reads `WORKOS_API_KEY` env var.
- **HTTP client**: `httpx` for sync HTTP with connection pooling.

## Naming Conventions

| Concept          | Convention   | Example                                  |
| ---------------- | ------------ | ---------------------------------------- |
| Class            | PascalCase   | `Organization`, `UserManagement`         |
| Method           | snake_case   | `list_organizations`, `create_organization` |
| Field            | snake_case   | `allow_profiles_outside_organization`    |
| File             | snake_case   | `organization.py`                        |
| Directory        | snake_case   | `organizations/`, `user_management/`     |
| Module           | snake_case   | `workos.organizations`                   |
| Service property | snake_case   | `workos.organizations`, `workos.user_management` |
| Enum member      | UPPER_SNAKE  | `OrganizationDomainVerificationStrategy.DNS` |
| Package          | snake_case   | `workos`                                 |

### Overlay Resolution

All service-derived names are resolved through the overlay before falling back to the default PascalCase convention. Method names and type names also check the overlay for backwards-compatible naming.

## Type Mapping

| IR TypeRef                | Python Type                  |
| ------------------------- | ---------------------------- |
| `string`                  | `str`                        |
| `string` (date)           | `str`                        |
| `string` (date-time)      | `str`                        |
| `string` (uuid)           | `str`                        |
| `string` (binary)         | `bytes`                      |
| `integer`                 | `int`                        |
| `number`                  | `float`                      |
| `boolean`                 | `bool`                       |
| `unknown`                 | `Any`                        |
| `array(T)`                | `List[T]`                    |
| `model(Name)`             | `Name`                       |
| `enum(Name)`              | `Name`                       |
| `nullable(T)`             | `Optional[T]`                |
| `union(V1,V2)`            | `Union[V1, V2]`              |
| `map(V)`                  | `Dict[str, V]`               |
| `literal(v)`              | `Literal["v"]`               |

## Model Pattern

```python
from dataclasses import dataclass
from typing import Optional, List, Dict, Any


@dataclass
class Organization:
    """An organization within WorkOS."""

    id: str
    name: str
    allow_profiles_outside_organization: bool
    domains: List["OrganizationDomain"]
    created_at: str
    updated_at: str
    external_id: Optional[str] = None
    stripe_customer_id: Optional[str] = None
    metadata: Optional[Dict[str, str]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Organization":
        return cls(
            id=data["id"],
            name=data["name"],
            allow_profiles_outside_organization=data["allow_profiles_outside_organization"],
            domains=[OrganizationDomain.from_dict(d) for d in data.get("domains", [])],
            created_at=data["created_at"],
            updated_at=data["updated_at"],
            external_id=data.get("external_id"),
            stripe_customer_id=data.get("stripe_customer_id"),
            metadata=data.get("metadata"),
        )

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "allow_profiles_outside_organization": self.allow_profiles_outside_organization,
            "domains": [d.to_dict() for d in self.domains],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }
        if self.external_id is not None:
            result["external_id"] = self.external_id
        if self.stripe_customer_id is not None:
            result["stripe_customer_id"] = self.stripe_customer_id
        if self.metadata is not None:
            result["metadata"] = self.metadata
        return result
```

Key patterns:

- Dataclasses with type annotations
- Required fields first, optional fields after (with `= None`)
- `from_dict` class method for deserialization from API response
- `to_dict` instance method for serialization
- Nested model refs deserialized recursively via their own `from_dict`
- Array fields use list comprehension for nested deserialization
- Optional fields use `data.get()` for safe access

## Enum Pattern

```python
from enum import Enum


class OrganizationDomainVerificationStrategy(str, Enum):
    """Verification strategy for organization domains."""

    DNS = "dns"
    MANUAL = "manual"
```

Key patterns:

- Inherit from `StrEnum` (Python 3.11+)
- Member names: UPPER_SNAKE_CASE
- Member values: original string from spec

## Resource Pattern

```python
from typing import Optional
from ..types import RequestOptions
from .models import Organization, CreateOrganizationParams
from ..pagination import SyncPage


class Organizations:
    """Resource for managing organizations."""

    def __init__(self, client: "WorkOS") -> None:
        self._client = client

    def list_organizations(
        self,
        *,
        limit: Optional[int] = None,
        before: Optional[str] = None,
        after: Optional[str] = None,
        order: Optional[str] = None,
        request_options: Optional[RequestOptions] = None,
    ) -> SyncPage[Organization]:
        """List all organizations.

        Args:
            limit: Maximum number of records to return.
            before: Pagination cursor for previous page.
            after: Pagination cursor for next page.
            order: Sort order.
            request_options: Per-request options (extra headers, timeout).

        Returns:
            A paginated list of organizations.
        """
        return self._client._request_page(
            method="get",
            path="organizations",
            model=Organization,
            params={k: v for k, v in {
                "limit": limit,
                "before": before,
                "after": after,
                "order": order,
            }.items() if v is not None},
            request_options=request_options,
        )

    def create_organization(
        self,
        *,
        name: str,
        domain_data: Optional[list] = None,
        external_id: Optional[str] = None,
        metadata: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
        request_options: Optional[RequestOptions] = None,
    ) -> Organization:
        """Create a new organization.

        Args:
            name: The name of the organization.
            domain_data: Domain configuration.
            external_id: An external identifier.
            metadata: Key-value metadata.
            idempotency_key: Idempotency key for safe retries.
            request_options: Per-request options.

        Returns:
            The created organization.
        """
        body = {k: v for k, v in {
            "name": name,
            "domain_data": domain_data,
            "external_id": external_id,
            "metadata": metadata,
        }.items() if v is not None}
        return self._client._request(
            method="post",
            path="organizations",
            body=body,
            model=Organization,
            idempotency_key=idempotency_key,
            request_options=request_options,
        )

    def get_organization(
        self,
        organization_id: str,
        *,
        request_options: Optional[RequestOptions] = None,
    ) -> Organization:
        """Get an organization by ID.

        Args:
            organization_id: The ID of the organization.
            request_options: Per-request options.

        Returns:
            The organization.
        """
        return self._client._request(
            method="get",
            path=f"organizations/{organization_id}",
            model=Organization,
            request_options=request_options,
        )

    def delete_organization(
        self,
        organization_id: str,
        *,
        request_options: Optional[RequestOptions] = None,
    ) -> None:
        """Delete an organization.

        Args:
            organization_id: The ID of the organization.
            request_options: Per-request options.
        """
        self._client._request(
            method="delete",
            path=f"organizations/{organization_id}",
            request_options=request_options,
        )
```

Key patterns:

- Constructor takes `client: "WorkOS"`
- All parameters after the first positional are keyword-only (`*`)
- List methods return `SyncPage[T]` with pagination params
- Create/update methods: build body dict, POST, return deserialized model
- Get methods: GET with path interpolation via f-string, return deserialized model
- Delete methods: return `None`
- Idempotent POSTs: `idempotency_key` as standalone keyword parameter
- Every method takes optional `request_options` as the last parameter
- Google-style docstrings

## Pagination Pattern

```python
from dataclasses import dataclass
from typing import TypeVar, Generic, List, Optional, Iterator, Callable, Dict, Any

T = TypeVar("T")


@dataclass
class SyncPage(Generic[T]):
    """A page of results with auto-pagination support."""

    data: List[T]
    list_metadata: Dict[str, Any]
    _fetch_page: Optional[Callable[..., "SyncPage[T]"]] = None

    @property
    def after(self) -> Optional[str]:
        return self.list_metadata.get("after")

    def has_more(self) -> bool:
        return self.after is not None

    def auto_paging_iter(self) -> Iterator[T]:
        page = self
        while True:
            yield from page.data
            if not page.has_more() or page._fetch_page is None:
                break
            page = page._fetch_page(after=page.after)
```

## Error Handling

```python
class WorkOSError(Exception):
    """Base exception for all WorkOS errors."""

    def __init__(self, message: str, *, status_code: int | None = None, request_id: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.request_id = request_id


class AuthenticationError(WorkOSError):
    """401 Unauthorized."""
    pass

class NotFoundError(WorkOSError):
    """404 Not Found."""
    pass

class BadRequestError(WorkOSError):
    """400 Bad Request."""
    pass

class UnprocessableEntityError(WorkOSError):
    """422 Unprocessable Entity."""
    pass

class RateLimitExceededError(WorkOSError):
    """429 Rate Limited."""
    pass

class ServerError(WorkOSError):
    """500+ Server Error."""
    pass

class ConfigurationError(WorkOSError):
    """Missing or invalid configuration (e.g., no API key)."""
    pass
```

| Exception Class            | Status Code |
| -------------------------- | ----------- |
| `BadRequestError`          | 400         |
| `AuthenticationError`      | 401         |
| `NotFoundError`            | 404         |
| `UnprocessableEntityError` | 422         |
| `RateLimitExceededError`   | 429         |
| `ServerError`              | 500+        |
| `ConfigurationError`       | runtime     |

## Client Architecture

```python
import os
from typing import Optional, Type, TypeVar, Dict, Any
import httpx

T = TypeVar("T")


class WorkOS:
    """WorkOS API client."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: str = "https://api.workos.com",
        timeout: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self._api_key = api_key or os.environ.get("WORKOS_API_KEY")
        if not self._api_key:
            raise ConfigurationError("No API key provided")
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._client = httpx.Client(timeout=timeout)

        # Resource accessors
        self.organizations = Organizations(self)
        # ... other resources

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        body: Optional[Dict[str, Any]] = None,
        model: Optional[Type[T]] = None,
        idempotency_key: Optional[str] = None,
        request_options: Optional[RequestOptions] = None,
    ) -> T | None:
        # Build request, handle retries, deserialize response
        ...
```

## HTTP Client (Retry Logic)

- `MAX_RETRIES = 3`
- `INITIAL_RETRY_DELAY = 0.5` (seconds)
- `MAX_RETRY_DELAY = 8.0` (seconds)
- `RETRY_MULTIPLIER = 2.0`
- Retryable statuses: `429, 500, 502, 503, 504`
- Backoff: `min(INITIAL_RETRY_DELAY * RETRY_MULTIPLIER ** attempt, MAX_RETRY_DELAY)`
- Jitter: `delay * (0.5 + random())`
- Respect `Retry-After` header for 429
- Auto-generated UUID idempotency keys for POST, reused across retries

## Testing Pattern

Framework: pytest + pytest-httpx

```python
import pytest
from workos import WorkOS
from workos.organizations.models import Organization


@pytest.fixture
def workos():
    return WorkOS(api_key="sk_test_Sz3IQjepeSWaI4cMS4ms4sMuU")


class TestOrganizations:
    def test_list_organizations(self, workos, httpx_mock):
        httpx_mock.add_response(
            url="https://api.workos.com/organizations",
            json=load_fixture("list_organizations.json"),
        )
        page = workos.organizations.list_organizations()
        assert len(page.data) == 7
        assert isinstance(page.data[0], Organization)

    def test_get_organization(self, workos, httpx_mock):
        httpx_mock.add_response(
            url="https://api.workos.com/organizations/org_01234",
            json=load_fixture("organization.json"),
        )
        org = workos.organizations.get_organization("org_01234")
        assert org.id == "org_01234"
        assert isinstance(org, Organization)

    def test_delete_organization(self, workos, httpx_mock):
        httpx_mock.add_response(
            url="https://api.workos.com/organizations/org_01234",
            status_code=204,
        )
        result = workos.organizations.delete_organization("org_01234")
        assert result is None

    def test_unauthorized_error(self, workos, httpx_mock):
        httpx_mock.add_response(
            url="https://api.workos.com/organizations",
            status_code=401,
            json={"message": "Unauthorized"},
        )
        with pytest.raises(AuthenticationError):
            workos.organizations.list_organizations()
```

## Directory Structure

```
{namespace}/
├── __init__.py                     # Package init, re-exports WorkOS client
├── _client.py                      # Main WorkOS client class
├── _config.py                      # Configuration, RequestOptions
├── _errors.py                      # Error hierarchy
├── _pagination.py                  # SyncPage, auto-pagination
├── _types.py                       # Shared type aliases, RequestOptions
├── {service}/
│   ├── __init__.py                 # Re-exports models and resource
│   ├── _resource.py                # Resource class (e.g., Organizations)
│   ├── models.py                   # Dataclass models and enums
│   └── fixtures/                   # JSON test fixtures
├── tests/
│   ├── conftest.py                 # Shared fixtures (workos client, load_fixture)
│   └── test_{service}.py           # Per-service test file
├── py.typed                        # PEP 561 marker
└── pyproject.toml                  # Package manifest
```

## Structural Guidelines

| Category          | Choice                      |
| ----------------- | --------------------------- |
| Testing Framework | pytest                      |
| HTTP Mocking      | pytest-httpx                |
| Documentation     | Google-style docstrings     |
| Type Signatures   | Inline type annotations     |
| Linting           | ruff                        |
| Formatting        | ruff format                 |
| HTTP Client       | httpx                       |
| JSON Parsing      | Built-in json               |
| Package Manager   | pip / pyproject.toml        |
| Build Tool        | hatchling                   |
| Models            | dataclasses                 |
| Enums             | str, Enum (Python 3.9+)     |
| Python Version    | >= 3.9 (uses `from __future__ import annotations`) |

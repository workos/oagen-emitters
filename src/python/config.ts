import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate Python configuration and shared type files.
 */
export function generateConfig(ctx?: EmitterContext): GeneratedFile[] {
  const namespace = ctx?.namespace ?? 'workos';
  const files: GeneratedFile[] = [];

  // _types.py — shared type aliases and protocols
  files.push({
    path: `src/${namespace}/_types.py`,
    content: `from __future__ import annotations

import sys
from datetime import datetime
from enum import Enum
from typing import Any, Dict, Protocol, TypeVar
from typing_extensions import Self, TypedDict


class RequestOptions(TypedDict, total=False):
    """Per-request options that can be passed to any API method."""

    extra_headers: Dict[str, str]
    timeout: float
    idempotency_key: str
    max_retries: int
    base_url: str


class Deserializable(Protocol):
    """Protocol for types that can be deserialized from a dict."""

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Self: ...


def enum_value(value: Any) -> Any:
    """Serialize enum-like values without rejecting raw string inputs."""
    return value.value if isinstance(value, Enum) else value


D = TypeVar("D", bound=Deserializable)


def _parse_datetime(value: str) -> datetime:
    """Parse an ISO 8601 datetime string, handling 'Z' suffix.

    On Python 3.11+ fromisoformat handles 'Z' natively;
    on older versions we replace 'Z' with '+00:00'.
    """
    if sys.version_info >= (3, 11):
        return datetime.fromisoformat(value)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))`,
    integrateTarget: true,
    overwriteExisting: true,
  });

  // _pagination.py — SyncPage and auto-pagination
  files.push({
    path: `src/${namespace}/_pagination.py`,
    content: `from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, Generic, Iterator, List, Optional, TypeVar

from ._types import Deserializable

T = TypeVar("T", bound=Deserializable)


@dataclass(slots=True)
class ListMetadata:
    """Pagination cursor metadata."""

    before: Optional[str] = None
    after: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ListMetadata":
        return cls(before=data.get("before"), after=data.get("after"))


@dataclass
class SyncPage(Generic[T]):
    """A page of results with auto-pagination support."""

    data: List[T]
    list_metadata: ListMetadata
    _fetch_page: Optional[Callable[..., "SyncPage[T]"]] = field(default=None, repr=False)

    @property
    def before(self) -> Optional[str]:
        """Cursor for the previous page, if available."""
        return self.list_metadata.before

    @property
    def after(self) -> Optional[str]:
        """Cursor for the next page, if available."""
        return self.list_metadata.after

    def has_more(self) -> bool:
        """Whether there are more pages available."""
        return self.after is not None

    def auto_paging_iter(self) -> Iterator[T]:
        """Iterate through all items across all pages."""
        page = self
        while True:
            yield from page.data
            if not page.data:
                break
            if not page.has_more() or page._fetch_page is None:
                break
            page = page._fetch_page(after=page.after)

    def __iter__(self) -> Iterator[T]:
        """Iterate through all items across all pages."""
        return self.auto_paging_iter()


@dataclass
class AsyncPage(Generic[T]):
    """A page of results with async auto-pagination support."""

    data: List[T]
    list_metadata: ListMetadata
    _fetch_page: Optional[Callable[..., Awaitable["AsyncPage[T]"]]] = field(default=None, repr=False)

    @property
    def before(self) -> Optional[str]:
        """Cursor for the previous page, if available."""
        return self.list_metadata.before

    @property
    def after(self) -> Optional[str]:
        """Cursor for the next page, if available."""
        return self.list_metadata.after

    def has_more(self) -> bool:
        """Whether there are more pages available."""
        return self.after is not None

    async def auto_paging_iter(self) -> AsyncIterator[T]:
        """Iterate through all items across all pages."""
        page = self
        while True:
            for item in page.data:
                yield item
            if not page.data:
                break
            if not page.has_more() or page._fetch_page is None:
                break
            page = await page._fetch_page(after=page.after)

    async def __aiter__(self) -> AsyncIterator[T]:
        """Iterate through all items across all pages."""
        async for item in self.auto_paging_iter():
            yield item`,
    integrateTarget: true,
    overwriteExisting: true,
  });

  return files;
}

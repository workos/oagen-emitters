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


D = TypeVar("D", bound=Deserializable)`,
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


@dataclass
class SyncPage(Generic[T]):
    """A page of results with auto-pagination support."""

    data: List[T]
    list_metadata: Dict[str, Any]
    _fetch_page: Optional[Callable[..., "SyncPage[T]"]] = field(default=None, repr=False)

    @property
    def after(self) -> Optional[str]:
        """Cursor for the next page, if available."""
        return self.list_metadata.get("after")

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


@dataclass
class AsyncPage(Generic[T]):
    """A page of results with async auto-pagination support."""

    data: List[T]
    list_metadata: Dict[str, Any]
    _fetch_page: Optional[Callable[..., Awaitable["AsyncPage[T]"]]] = field(default=None, repr=False)

    @property
    def after(self) -> Optional[str]:
        """Cursor for the next page, if available."""
        return self.list_metadata.get("after")

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
            page = await page._fetch_page(after=page.after)`,
    integrateTarget: true,
    overwriteExisting: true,
  });

  return files;
}

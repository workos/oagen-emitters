import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate Python configuration and shared type files.
 */
export function generateConfig(ctx?: EmitterContext): GeneratedFile[] {
  const namespace = ctx?.namespace ?? 'workos';
  const files: GeneratedFile[] = [];

  // _types.py — shared type aliases
  files.push({
    path: `${namespace}/_types.py`,
    content: `from typing import Any, Dict, Optional

# Per-request options that can be passed to any API method.
RequestOptions = Dict[str, Any]
"""
Supported keys:
- extra_headers: Dict[str, str] — additional HTTP headers
- timeout: float — request timeout in seconds
"""`,
    skipIfExists: true,
    integrateTarget: false,
  });

  // _pagination.py — SyncPage and auto-pagination
  files.push({
    path: `${namespace}/_pagination.py`,
    content: `from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Generic, Iterator, List, Optional, TypeVar

T = TypeVar("T")


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

    @property
    def before(self) -> Optional[str]:
        """Cursor for the previous page, if available."""
        return self.list_metadata.get("before")

    def has_more(self) -> bool:
        """Whether there are more pages available."""
        return self.after is not None

    def auto_paging_iter(self) -> Iterator[T]:
        """Iterate through all items across all pages."""
        page = self
        while True:
            yield from page.data
            if not page.has_more() or page._fetch_page is None:
                break
            page = page._fetch_page(after=page.after)`,
    skipIfExists: true,
    integrateTarget: false,
  });

  return files;
}

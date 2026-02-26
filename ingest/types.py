from collections.abc import Callable, Iterable
from dataclasses import dataclass, field


@dataclass
class Page:
    id: int
    version: int
    url: str
    domain: str
    filename: str
    title: str = ""


@dataclass
class Chunk:
    idx: int
    header: str
    header_path: list[str]
    content: str
    token_count: int = 0
    subindex: int = 0


@dataclass
class PageSource:
    page: Page
    lines: Iterable[str]
    initial_header: str = ""
    initial_header_path: list[str] = field(default_factory=list)
    refentry: bool = False
    header_transform: Callable[[str], str] | None = None

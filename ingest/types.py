from dataclasses import dataclass


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

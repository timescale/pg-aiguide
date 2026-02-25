import math
import re
from typing import Callable, Iterable

from ingest.constants import MAX_CHUNK_TOKENS, MIN_CHUNK_TOKENS
from ingest.encoder import ENC
from ingest.types import Chunk


def create_chunks(idx: int, header: str, header_path: str, content: str) -> list[Chunk]:
    chunks = []
    tokens = ENC.encode(content)
    number_of_chunks = math.ceil(len(tokens) / MAX_CHUNK_TOKENS)

    for sub_idx in range(number_of_chunks):
        chunk_tokens = tokens[
            sub_idx * MAX_CHUNK_TOKENS : (sub_idx + 1) * MAX_CHUNK_TOKENS
        ]

        # discard chunks that are too tiny to be useful
        if len(chunk_tokens) < MIN_CHUNK_TOKENS:
            continue

        chunk_content = ENC.decode(chunk_tokens)
        chunks.append(
            Chunk(
                idx=idx,
                header=header,
                header_path=header_path,
                content=chunk_content,
                token_count=len(chunk_tokens),
                subindex=sub_idx,
            )
        )

    return chunks


_HEADER_PATTERN = re.compile(r"^(#{1,3}) (.+)$")
_CODEBLOCK_PATTERN = re.compile(r"^```")


def chunk_markdown_lines(
    lines: Iterable[str],
    initial_header: str,
    initial_header_path: list[str],
    *,
    refentry: bool = False,
    header_transform: Callable[[str], str] | None = None,
) -> list[Chunk]:
    """Split an iterable of markdown lines into chunks based on headers.

    Args:
        lines: Iterable of lines (e.g. str.split("\\n"), a file object, etc.)
        initial_header: Header label to use before the first header is encountered.
        initial_header_path: Header path to use before the first header is encountered.
        refentry: If True, only the first header starts a chunk; subsequent headers
            are treated as content (postgres refentry pages).
        header_transform: Optional function to clean up header text before storing
            it in header/header_path metadata.
    """
    chunks: list[Chunk] = []
    current_chunk_lines: list[str] = []
    current_header = initial_header
    header_path = list(initial_header_path)
    idx = 0
    in_codeblock = False

    def flush() -> None:
        nonlocal idx
        content = "\n".join(current_chunk_lines).strip()
        if content:
            chunks.extend(
                create_chunks(
                    idx=idx,
                    header=current_header,
                    header_path=header_path.copy(),
                    content=content,
                )
            )
            idx += 1

    for line in lines:
        stripped = line.rstrip("\n")
        match = _HEADER_PATTERN.match(stripped)

        if match is None or in_codeblock or (refentry and current_chunk_lines):
            if _CODEBLOCK_PATTERN.match(stripped):
                in_codeblock = not in_codeblock
            current_chunk_lines.append(stripped)
            continue

        # It's a header — flush current chunk and start a new one
        flush()
        current_chunk_lines = []

        depth = len(match.group(1))
        header = match.group(2).strip()
        if header_transform:
            header = header_transform(header)

        header_path = header_path[: depth - 1] + [header]
        current_header = header

    flush()
    return chunks

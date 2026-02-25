import math

from ingest.constants import MAX_CHUNK_TOKENS
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

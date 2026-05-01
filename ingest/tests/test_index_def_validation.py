"""Tests for CREATE INDEX statement validation in document_importer.

These guard against second-order SQL injection: ``finalize_database`` re-runs
the ``indexdef`` strings captured from ``pg_indexes`` during ``init_database``.
A malicious or unexpected catalog entry must not be able to smuggle additional
SQL or target a table other than the importer's own chunks table.
"""

from __future__ import annotations

import pytest
from ingest.document_importer import _validate_index_def


@pytest.mark.parametrize(
    "index_def",
    [
        "CREATE UNIQUE INDEX chunks_pkey ON docs.chunks USING btree (id)",
        "CREATE INDEX idx_chunks_page_id ON docs.chunks USING btree (page_id)",
        (
            "CREATE INDEX chunks_bm25_idx ON docs.chunks "
            "USING bm25 (id, content) WITH (key_field=id)"
        ),
        # Trailing semicolon is acceptable (some catalog renderings include it).
        "CREATE INDEX idx_chunks_page_id ON docs.chunks USING btree (page_id);",
    ],
)
def test_accepts_canonical_create_index(index_def: str) -> None:
    result = _validate_index_def(index_def, "chunks")
    assert result.lower().startswith("create")
    assert "docs.chunks" in result.lower() or "chunks" in result.lower()


@pytest.mark.parametrize(
    "index_def",
    [
        # Stacked-statement injection.
        "CREATE INDEX x ON docs.chunks (id); DROP TABLE docs.pages; --",
        "CREATE INDEX x ON docs.chunks (id); CREATE INDEX y ON docs.chunks(id)",
        # Wrong target table — refuses to touch anything other than chunks.
        "CREATE INDEX x ON docs.other_table (id)",
        "CREATE INDEX x ON docs.pg_class (id)",
        # Outright non-CREATE-INDEX DDL.
        "DROP TABLE docs.chunks",
        "ALTER TABLE docs.chunks ADD COLUMN evil text",
        "SELECT pg_sleep(10)",
        "",
    ],
)
def test_rejects_malicious_or_unexpected_definitions(index_def: str) -> None:
    with pytest.raises(ValueError):
        _validate_index_def(index_def, "chunks")


def test_rejects_non_string() -> None:
    with pytest.raises(ValueError):
        _validate_index_def(None, "chunks")  # type: ignore[arg-type]

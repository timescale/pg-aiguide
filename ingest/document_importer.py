import json
import re
from abc import ABC, abstractmethod
from collections.abc import Iterable

import openai
import psycopg
from ingest.constants import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    OPENAI_API_KEY,
    OPENAI_BASE_URL,
)
from ingest.types import Chunk, Page, PageSource
from ingest.utils.chunking import chunk_markdown_lines
from psycopg.sql import SQL, Identifier


class DocumentImporter(ABC):
    def __init__(self, version: str | int, pages_table: str, chunks_table: str):
        self.version = version
        self.pages_table = pages_table
        self.chunks_table = chunks_table

    @abstractmethod
    def get_pages(self) -> Iterable[PageSource]:
        """Yield PageSource objects, one per page to be imported."""
        ...

    # ------------------------------------------------------------------ #
    # Embedding                                                            #
    # ------------------------------------------------------------------ #

    def embed(self, content: str) -> list[float] | None:
        client_kwargs: dict = {"api_key": OPENAI_API_KEY}
        if OPENAI_BASE_URL:
            client_kwargs["base_url"] = OPENAI_BASE_URL
        client = openai.OpenAI(**client_kwargs)
        try:
            return (
                client.embeddings.create(
                    model=EMBEDDING_MODEL,
                    input=content,
                    dimensions=EMBEDDING_DIMENSIONS,
                )
                .data[0]
                .embedding
            )
        except Exception as e:
            print(f"  Warning: Failed to generate embedding: {e}")
            return None

    # ------------------------------------------------------------------ #
    # Database helpers                                                     #
    # ------------------------------------------------------------------ #

    def insert_page(self, conn: psycopg.Connection, page: Page) -> None:
        print(f"inserting page {page.filename} {page.url}")
        result = conn.execute(
            f"""
            INSERT INTO docs.{self.pages_table}_tmp
            (version, url, domain, filename, content_length, chunks_count)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            [page.version, page.url, page.domain, page.filename, 0, 0],
        )
        row = result.fetchone()
        assert row is not None
        page.id = row[0]

    def insert_chunk(self, conn: psycopg.Connection, page: Page, chunk: Chunk) -> None:
        print(f"header: {chunk.header}")
        url = page.url
        if len(chunk.header_path) > 1:
            match = re.search(r"\((#\S+)\)", chunk.header_path[-1])
            if match:
                url += match.group(1).lower()

        embedding = self.embed(chunk.content)
        conn.execute(
            f"""
            INSERT INTO docs.{self.chunks_table}_tmp
            (page_id, chunk_index, sub_chunk_index, content, metadata, embedding)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            [
                page.id,
                chunk.idx,
                chunk.subindex,
                chunk.content,
                json.dumps(
                    {
                        "header": chunk.header,
                        "header_path": chunk.header_path,
                        "source_url": url,
                        "token_count": chunk.token_count,
                    }
                ),
                embedding,
            ],
        )

    def update_page_stats(self, conn: psycopg.Connection, page: Page) -> None:
        conn.execute(
            f"""
            UPDATE docs.{self.pages_table}_tmp p
            SET
                content_length = COALESCE(chunks_stats.total_length, 0),
                chunks_count = COALESCE(chunks_stats.chunks_count, 0)
            FROM (
                SELECT
                    page_id,
                    SUM(char_length(content)) AS total_length,
                    COUNT(*) AS chunks_count
                FROM docs.{self.chunks_table}_tmp
                WHERE page_id = %s
                GROUP BY page_id
            ) AS chunks_stats
            WHERE p.id = chunks_stats.page_id AND p.id = %s
            """,
            [page.id, page.id],
        )

    # ------------------------------------------------------------------ #
    # Table lifecycle                                                      #
    # ------------------------------------------------------------------ #

    def init_database(self, conn: psycopg.Connection) -> None:
        """Set up _tmp tables, copying across any rows for other versions."""
        print("Initializing database tables...")

        # Capture existing index definitions so we can recreate them after swap.
        self._index_defs_to_create = [
            row[0]
            for row in conn.execute(
                """
                SELECT indexdef
                FROM pg_indexes
                WHERE schemaname = 'docs'
                AND tablename = %s
                ORDER BY indexname
                """,
                [self.chunks_table],
            ).fetchall()
        ]

        conn.execute(f"DROP TABLE IF EXISTS docs.{self.chunks_table}_tmp CASCADE")
        conn.execute(f"DROP TABLE IF EXISTS docs.{self.pages_table}_tmp CASCADE")

        conn.execute(
            f"CREATE TABLE docs.{self.pages_table}_tmp "
            f"(LIKE docs.{self.pages_table} INCLUDING ALL EXCLUDING CONSTRAINTS)"
        )
        conn.execute(
            f"INSERT INTO docs.{self.pages_table}_tmp "
            f"SELECT * FROM docs.{self.pages_table} WHERE version != %s",
            [self.version],
        )

        # Exclude indexes from chunks tmp — BM25 and similar indexes can error
        # during INSERT; we recreate them after the swap.
        conn.execute(
            f"CREATE TABLE docs.{self.chunks_table}_tmp "
            f"(LIKE docs.{self.chunks_table} INCLUDING ALL EXCLUDING CONSTRAINTS EXCLUDING INDEXES)"
        )
        conn.execute(
            f"INSERT INTO docs.{self.chunks_table}_tmp "
            f"SELECT c.* FROM docs.{self.chunks_table} c "
            f"INNER JOIN docs.{self.pages_table} p ON c.page_id = p.id "
            f"WHERE p.version != %s",
            [self.version],
        )

        conn.execute(
            f"ALTER TABLE docs.{self.chunks_table}_tmp "
            f"ADD FOREIGN KEY (page_id) REFERENCES docs.{self.pages_table}_tmp(id) ON DELETE CASCADE"
        )
        conn.commit()

        conn.execute(
            f"SELECT setval(pg_get_serial_sequence('docs.{self.chunks_table}_tmp', 'id'), "
            f"(SELECT MAX(id) FROM docs.{self.chunks_table}_tmp))"
        )
        conn.execute(
            f"SELECT setval(pg_get_serial_sequence('docs.{self.pages_table}_tmp', 'id'), "
            f"(SELECT MAX(id) FROM docs.{self.pages_table}_tmp))"
        )
        conn.commit()

    def finalize_database(self, conn: psycopg.Connection) -> None:
        """Swap _tmp tables into place and clean up _tmp_ from index/FK names."""
        print("Finalizing database...")

        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS docs.{self.chunks_table} CASCADE")
            cur.execute(f"DROP TABLE IF EXISTS docs.{self.pages_table} CASCADE")
            cur.execute(
                f"ALTER TABLE docs.{self.chunks_table}_tmp RENAME TO {self.chunks_table}"
            )
            cur.execute(
                f"ALTER TABLE docs.{self.pages_table}_tmp RENAME TO {self.pages_table}"
            )

            for index_def in self._index_defs_to_create:
                cur.execute(index_def)

            for table in [self.pages_table, self.chunks_table]:
                cur.execute(
                    """
                    SELECT indexname FROM pg_indexes
                    WHERE schemaname = 'docs' AND tablename = %s AND indexname LIKE %s
                    """,
                    [table, "%_tmp_%"],
                )
                for row in cur.fetchall():
                    old_name = row[0]
                    cur.execute(
                        SQL("ALTER INDEX docs.{old} RENAME TO {new}").format(
                            old=Identifier(old_name),
                            new=Identifier(old_name.replace("_tmp_", "_")),
                        )
                    )

            cur.execute(
                """
                SELECT conname FROM pg_constraint
                WHERE conrelid = to_regclass(%s) AND contype = 'f' AND conname LIKE %s
                """,
                [f"docs.{self.chunks_table}", "%_tmp_%"],
            )
            for row in cur.fetchall():
                old_name = row[0]
                cur.execute(
                    SQL(
                        "ALTER TABLE docs.{table} RENAME CONSTRAINT {old} TO {new}"
                    ).format(
                        table=Identifier(self.chunks_table),
                        old=Identifier(old_name),
                        new=Identifier(old_name.replace("_tmp_", "_")),
                    )
                )

        conn.commit()
        print("Database finalized successfully.")

    # ------------------------------------------------------------------ #
    # Main loop                                                            #
    # ------------------------------------------------------------------ #

    def run(self, conn: psycopg.Connection) -> None:
        self.init_database(conn)

        page_count = 0
        for source in self.get_pages():
            chunks = chunk_markdown_lines(
                source.lines,
                initial_header=source.initial_header,
                initial_header_path=source.initial_header_path,
                refentry=source.refentry,
                header_transform=source.header_transform,
            )
            self.insert_page(conn, source.page)
            for chunk in chunks:
                self.insert_chunk(conn, source.page, chunk)
            conn.commit()
            self.update_page_stats(conn, source.page)
            conn.commit()
            page_count += 1

        self.finalize_database(conn)
        print(f"Processed {page_count} pages.")

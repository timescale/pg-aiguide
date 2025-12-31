#!/usr/bin/env python3
"""
PostGIS Manual Documentation Scraper

Since the PostGIS official manual (https://postgis.net/docs/manual-X.Y/) does not have
a sitemap, this script provides specialized scraping logic to handle the DocBook-generated
static HTML documentation.

Usage:
    uv run python postgis_docs.py --version 3.5 --storage-type file --max-pages 10
    uv run python postgis_docs.py --version 3.5 --storage-type database
"""

import argparse
from dataclasses import dataclass, field
from dotenv import load_dotenv
from bs4 import BeautifulSoup
import json
from markdownify import markdownify
import openai
import os
from pathlib import Path
import psycopg
from psycopg.sql import SQL, Identifier
import re
import requests
from urllib.parse import urljoin, urlparse
import tiktoken
from typing import Optional
import time

THIS_DIR = Path(__file__).parent.resolve()
load_dotenv(dotenv_path=os.path.join(THIS_DIR, "..", ".env"))

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL")  # Optional: custom API endpoint
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")  # Default model
EMBEDDING_DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "1536"))  # Default dimensions
BUILD_DIR = THIS_DIR / "build"
BUILD_DIR.mkdir(exist_ok=True)

POSTGIS_BASE_URL = "https://postgis.net/docs"
POSTGIS_DOMAIN = "postgis.net"

# Token counting using tiktoken
ENC = tiktoken.get_encoding("cl100k_base")
MAX_CHUNK_TOKENS = 7000

# Pages to skip (index, table of contents, etc.)
SKIP_PAGES = {
    "index.html",
    "bookindex.html",
    "PostGIS_Special_Functions_Index.html",
    "release_notes.html",
}

# HTML element selectors to remove
REMOVE_SELECTORS = [
    "script",
    "style",
    "header",
    "footer",
    ".navheader",
    ".navfooter",
    ".toc",
    ".titlepage .abstract img",
]


@dataclass
class Page:
    id: int
    version: str
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


class PostGISDocsScraper:
    """PostGIS documentation scraper for the official manual."""

    def __init__(
        self,
        version: str,
        storage_type: str = "database",
        output_dir: Optional[Path] = None,
        max_pages: Optional[int] = None,
        delay: float = 1.0,
        db_uri: Optional[str] = None,
    ):
        self.version = version
        self.storage_type = storage_type
        self.output_dir = output_dir or BUILD_DIR / f"postgis_{version}"
        self.max_pages = max_pages
        self.delay = delay
        self.db_uri = db_uri
        self.base_url = f"{POSTGIS_BASE_URL}/manual-{version}/"
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (compatible; PostGISDocsScraper/1.0)"
        })
        self.processed_urls: set[str] = set()
        self.pages_processed = 0

        if self.storage_type == "file":
            self.output_dir.mkdir(parents=True, exist_ok=True)

    def get_manual_pages(self) -> list[str]:
        """Get all page URLs from the manual index."""
        print(f"Fetching manual index from {self.base_url}...")

        try:
            response = self.session.get(self.base_url, timeout=30)
            response.raise_for_status()
        except Exception as e:
            raise RuntimeError(f"Failed to fetch manual index: {e}")

        soup = BeautifulSoup(response.content, "html.parser")

        # Extract all links from the table of contents
        pages = set()
        for link in soup.find_all("a", href=True):
            href = link["href"]
            # Only process relative HTML page links
            if href.endswith(".html") and not href.startswith("http"):
                # Skip specific pages
                if href in SKIP_PAGES:
                    continue
                pages.add(href)

        # Sort for consistent processing order
        return sorted(pages)

    def fetch_page(self, page_url: str) -> Optional[BeautifulSoup]:
        """Fetch and parse a single page."""
        full_url = urljoin(self.base_url, page_url)

        if full_url in self.processed_urls:
            return None

        try:
            time.sleep(self.delay)
            response = self.session.get(full_url, timeout=30)
            response.raise_for_status()
            self.processed_urls.add(full_url)
            return BeautifulSoup(response.content, "html.parser")
        except Exception as e:
            print(f"Error fetching {full_url}: {e}")
            return None

    def clean_html(self, soup: BeautifulSoup) -> BeautifulSoup:
        """Clean HTML by removing unwanted elements."""
        for selector in REMOVE_SELECTORS:
            for element in soup.select(selector):
                element.decompose()

        # Remove images with data: URLs
        for img in soup.find_all("img", src=True):
            if img["src"].startswith("data:"):
                img.decompose()

        return soup

    def extract_title(self, soup: BeautifulSoup) -> str:
        """Extract page title."""
        title_tag = soup.find("title")
        if title_tag:
            return title_tag.get_text().strip()

        h1 = soup.find("h1")
        if h1:
            return h1.get_text().strip()

        h2 = soup.find("h2")
        if h2:
            return h2.get_text().strip()

        return "PostGIS Documentation"

    def html_to_markdown(self, soup: BeautifulSoup) -> str:
        """Convert HTML to Markdown."""
        # Find main content area
        main_content = (
            soup.find("div", class_="refentry") or
            soup.find("div", class_="chapter") or
            soup.find("div", class_="section") or
            soup.find("div", class_="book") or
            soup.find("body") or
            soup
        )

        return markdownify(str(main_content), heading_style="ATX")

    def chunk_markdown(self, markdown: str, page: Page) -> list[Chunk]:
        """Split Markdown into chunks based on headers."""
        chunks = []
        header_pattern = re.compile(r"^(#{1,3}) (.+)$", re.MULTILINE)

        # Simple header-based chunking
        lines = markdown.split("\n")
        current_chunk_lines = []
        current_header = page.title
        header_path = [page.title]
        idx = 0

        for line in lines:
            match = header_pattern.match(line)
            if match:
                # Save current chunk
                if current_chunk_lines:
                    content = "\n".join(current_chunk_lines).strip()
                    if content:
                        chunks.append(Chunk(
                            idx=idx,
                            header=current_header,
                            header_path=header_path.copy(),
                            content=content,
                        ))
                        idx += 1

                # Start new chunk
                depth = len(match.group(1))
                current_header = match.group(2).strip()
                header_path = header_path[:depth-1] + [current_header]
                current_chunk_lines = [line]
            else:
                current_chunk_lines.append(line)

        # Save final chunk
        if current_chunk_lines:
            content = "\n".join(current_chunk_lines).strip()
            if content:
                chunks.append(Chunk(
                    idx=idx,
                    header=current_header,
                    header_path=header_path.copy(),
                    content=content,
                ))

        return chunks

    def process_chunks(self, chunks: list[Chunk]) -> list[Chunk]:
        """Process chunks: count tokens and split oversized chunks."""
        processed = []

        for chunk in chunks:
            chunk.token_count = len(ENC.encode(chunk.content))

            # Skip chunks that are too small
            if chunk.token_count < 10:
                continue

            # Split oversized chunks
            if chunk.token_count > MAX_CHUNK_TOKENS:
                subchunks = self.split_chunk(chunk)
                processed.extend(subchunks)
            else:
                processed.append(chunk)

        return processed

    def split_chunk(self, chunk: Chunk) -> list[Chunk]:
        """Split an oversized chunk into smaller pieces."""
        num_subchunks = (chunk.token_count // MAX_CHUNK_TOKENS) + 1
        input_ids = ENC.encode(chunk.content)
        tokens_per_chunk = len(input_ids) // num_subchunks

        subchunks = []
        subindex = 0
        idx = 0

        while idx < len(input_ids):
            cur_idx = min(idx + tokens_per_chunk, len(input_ids))
            chunk_ids = input_ids[idx:cur_idx]

            if not chunk_ids:
                break

            decoded = ENC.decode(chunk_ids)
            if decoded:
                subchunks.append(Chunk(
                    idx=chunk.idx,
                    header=chunk.header,
                    header_path=chunk.header_path,
                    content=decoded,
                    token_count=len(chunk_ids),
                    subindex=subindex,
                ))
                subindex += 1

            if cur_idx == len(input_ids):
                break
            idx += tokens_per_chunk

        return subchunks

    def save_to_file(self, page: Page, markdown: str, chunks: list[Chunk]) -> None:
        """Save content to file."""
        # Save complete Markdown
        md_file = self.output_dir / f"{Path(page.filename).stem}.md"
        content = f"""---
title: {page.title}
url: {page.url}
version: {page.version}
chunks: {len(chunks)}
---

{markdown}
"""
        md_file.write_text(content, encoding="utf-8")
        print(f"  Saved: {md_file.name} ({len(chunks)} chunks)")

    def save_to_database(
        self,
        conn: psycopg.Connection,
        page: Page,
        chunks: list[Chunk],
    ) -> None:
        """Save content to database."""
        # Initialize OpenAI client with optional custom base URL
        client_kwargs = {"api_key": OPENAI_API_KEY}
        if OPENAI_BASE_URL:
            client_kwargs["base_url"] = OPENAI_BASE_URL
        client = openai.OpenAI(**client_kwargs)

        # Insert page record
        result = conn.execute(
            """
            INSERT INTO docs.postgis_pages_tmp
            (version, url, domain, filename, content_length, chunks_count)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            [
                page.version,
                page.url,
                page.domain,
                page.filename,
                sum(len(c.content) for c in chunks),
                len(chunks),
            ],
        )
        row = result.fetchone()
        assert row is not None
        page.id = row[0]

        # Insert chunk records
        for chunk in chunks:
            # Generate embedding using configurable model and dimensions
            try:
                embedding = (
                    client.embeddings.create(
                        model=EMBEDDING_MODEL,
                        input=chunk.content,
                        dimensions=EMBEDDING_DIMENSIONS,
                    )
                    .data[0]
                    .embedding
                )
            except Exception as e:
                print(f"  Warning: Failed to generate embedding: {e}")
                embedding = None

            conn.execute(
                """
                INSERT INTO docs.postgis_chunks_tmp
                (page_id, chunk_index, sub_chunk_index, content, metadata, embedding)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                [
                    page.id,
                    chunk.idx,
                    chunk.subindex,
                    chunk.content,
                    json.dumps({
                        "header": chunk.header,
                        "header_path": chunk.header_path,
                        "source_url": page.url,
                        "token_count": chunk.token_count,
                    }),
                    embedding,
                ],
            )

        conn.commit()
        print(f"  Saved to DB: {page.filename} ({len(chunks)} chunks)")

    def init_database(self, conn: psycopg.Connection) -> None:
        """Initialize database temporary tables."""
        print("Initializing database tables...")

        conn.execute("DROP TABLE IF EXISTS docs.postgis_chunks_tmp CASCADE")
        conn.execute("DROP TABLE IF EXISTS docs.postgis_pages_tmp CASCADE")

        # 创建页面表
        conn.execute("""
            CREATE TABLE IF NOT EXISTS docs.postgis_pages_tmp (
                id SERIAL PRIMARY KEY,
                version TEXT NOT NULL,
                url TEXT NOT NULL UNIQUE,
                domain TEXT NOT NULL,
                filename TEXT NOT NULL,
                content_length INTEGER DEFAULT 0,
                chunks_count INTEGER DEFAULT 0,
                scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # 创建块表
        conn.execute("""
            CREATE TABLE IF NOT EXISTS docs.postgis_chunks_tmp (
                id SERIAL PRIMARY KEY,
                page_id INTEGER REFERENCES docs.postgis_pages_tmp(id) ON DELETE CASCADE,
                chunk_index INTEGER NOT NULL,
                sub_chunk_index INTEGER DEFAULT 0,
                content TEXT NOT NULL,
                metadata JSONB,
                embedding vector(1536)
            )
        """)

        conn.commit()

    def finalize_database(self, conn: psycopg.Connection) -> None:
        """Finalize database operations by renaming temporary tables."""
        print("Finalizing database...")

        with conn.cursor() as cur:
            # Drop old tables if they exist
            cur.execute("DROP TABLE IF EXISTS docs.postgis_chunks CASCADE")
            cur.execute("DROP TABLE IF EXISTS docs.postgis_pages CASCADE")

            # Rename temporary tables
            cur.execute("ALTER TABLE docs.postgis_chunks_tmp RENAME TO postgis_chunks")
            cur.execute("ALTER TABLE docs.postgis_pages_tmp RENAME TO postgis_pages")

            # Rename indexes and constraints
            for table in ["postgis_pages", "postgis_chunks"]:
                cur.execute("""
                    SELECT indexname
                    FROM pg_indexes
                    WHERE schemaname = 'docs'
                    AND tablename = %s
                    AND indexname LIKE %s
                """, [table, '%_tmp_%'])

                for row in cur.fetchall():
                    old_name = row[0]
                    new_name = old_name.replace("_tmp_", "_")
                    cur.execute(
                        SQL("ALTER INDEX docs.{old} RENAME TO {new}").format(
                            old=Identifier(old_name),
                            new=Identifier(new_name),
                        )
                    )

            # Rename foreign key constraints
            cur.execute("""
                SELECT conname
                FROM pg_constraint
                WHERE conrelid = to_regclass('docs.postgis_chunks')
                AND contype = 'f'
                AND conname LIKE %s
            """, ['%_tmp_%'])

            for row in cur.fetchall():
                old_name = row[0]
                new_name = old_name.replace("_tmp_", "_")
                cur.execute(
                    SQL("ALTER TABLE docs.postgis_chunks RENAME CONSTRAINT {old} TO {new}").format(
                        old=Identifier(old_name),
                        new=Identifier(new_name),
                    )
                )

        conn.commit()
        print("Database finalized successfully.")

    def run(self) -> None:
        """Run the scraper."""
        print(f"Starting PostGIS {self.version} documentation scraper...")
        print(f"Base URL: {self.base_url}")
        print(f"Storage type: {self.storage_type}")

        if self.max_pages:
            print(f"Max pages: {self.max_pages}")

        # Get all page URLs
        pages = self.get_manual_pages()
        print(f"Found {len(pages)} pages to process")

        if self.max_pages:
            pages = pages[:self.max_pages]
            print(f"Limited to {len(pages)} pages")

        # Database connection (if needed)
        conn = None
        if self.storage_type == "database":
            if not self.db_uri:
                raise ValueError("Database URI is required for database storage")
            conn = psycopg.connect(self.db_uri)
            self.init_database(conn)

        try:
            # Process each page
            for page_url in pages:
                print(f"\nProcessing: {page_url}")

                soup = self.fetch_page(page_url)
                if soup is None:
                    continue

                self.pages_processed += 1

                # Extract information
                title = self.extract_title(soup)
                soup = self.clean_html(soup)
                markdown = self.html_to_markdown(soup)

                # Create page object
                page = Page(
                    id=0,
                    version=self.version,
                    url=urljoin(self.base_url, page_url),
                    domain=POSTGIS_DOMAIN,
                    filename=page_url,
                    title=title,
                )

                # Chunk processing
                chunks = self.chunk_markdown(markdown, page)
                chunks = self.process_chunks(chunks)

                print(f"  Title: {title}")
                print(f"  Chunks: {len(chunks)}")

                # Save
                if self.storage_type == "file":
                    self.save_to_file(page, markdown, chunks)
                elif self.storage_type == "database" and conn:
                    self.save_to_database(conn, page, chunks)

            # Finalize database operations
            if conn:
                self.finalize_database(conn)

            print(f"\n{'='*50}")
            print(f"Completed! Processed {self.pages_processed} pages.")

        finally:
            if conn:
                conn.close()


def build_database_uri() -> Optional[str]:
    """Build database URI from environment variables."""
    db_url = os.environ.get("DB_URL")
    if db_url:
        return db_url

    pg_user = os.environ.get("PGUSER")
    pg_password = os.environ.get("PGPASSWORD")
    pg_host = os.environ.get("PGHOST")
    pg_port = os.environ.get("PGPORT")
    pg_database = os.environ.get("PGDATABASE")

    if all([pg_user, pg_password, pg_host, pg_port, pg_database]):
        return f"postgresql://{pg_user}:{pg_password}@{pg_host}:{pg_port}/{pg_database}"

    return None


def main():
    parser = argparse.ArgumentParser(
        description="Ingest PostGIS documentation into the database.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --version 3.5 --storage-type file --max-pages 10
  %(prog)s --version 3.5 --storage-type database
  %(prog)s --version 3.4 --output-dir ./postgis_3.4_docs
        """,
    )

    parser.add_argument(
        "--version", "-v",
        required=True,
        help="PostGIS version to ingest (e.g., 3.5, 3.4)",
    )

    parser.add_argument(
        "--storage-type",
        choices=["file", "database"],
        default="database",
        help="Storage type: file or database (default: database)",
    )

    parser.add_argument(
        "--output-dir", "-o",
        type=Path,
        help="Output directory for file storage (default: build/postgis_<version>)",
    )

    parser.add_argument(
        "--max-pages", "-m",
        type=int,
        help="Maximum number of pages to process",
    )

    parser.add_argument(
        "--delay", "-d",
        type=float,
        default=1.0,
        help="Delay between requests in seconds (default: 1.0)",
    )

    parser.add_argument(
        "--database-uri",
        help="PostgreSQL connection URI (default: from environment)",
    )

    args = parser.parse_args()

    # 验证数据库存储需求
    db_uri = args.database_uri or build_database_uri()
    if args.storage_type == "database" and not db_uri:
        print("Error: Database storage requires database connection configuration")
        print("Set environment variables: DB_URL or (PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE)")
        print("Or use --storage-type file for file-based storage")
        return 1

    # Validate OpenAI API Key (required for database storage)
    if args.storage_type == "database" and not OPENAI_API_KEY:
        print("Error: Database storage requires OPENAI_API_KEY for embeddings")
        print("Set it with: export OPENAI_API_KEY=your_api_key")
        return 1

    scraper = PostGISDocsScraper(
        version=args.version,
        storage_type=args.storage_type,
        output_dir=args.output_dir,
        max_pages=args.max_pages,
        delay=args.delay,
        db_uri=db_uri,
    )

    scraper.run()
    return 0


if __name__ == "__main__":
    exit(main())

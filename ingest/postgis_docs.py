#!/usr/bin/env python3
"""
PostGIS Manual Documentation Scraper

Since the PostGIS official manual (https://postgis.net/docs/manual-X.Y/) does not have
a sitemap, this script provides specialized scraping logic to handle the DocBook-generated
static HTML documentation.

Usage:
    uv run python postgis_docs.py --version 3.5 --max-pages 10
    uv run python postgis_docs.py --version 3.5
"""

import argparse
from collections.abc import Iterable
from urllib.parse import urljoin

import psycopg
import requests
from ingest.constants import POSTGIS_BASE_URL, POSTGIS_DOMAIN
from ingest.document_importer import DocumentImporter, PageSource
from ingest.types import Page
from ingest.utils.beautiful_soup import (
    clean_postgis_html,
    extract_title,
    fetch_page_as_soup,
    get_postgis_page_urls,
    postgis_html_to_markdown,
)
from ingest.utils.db import build_database_uri


class PostGISDocsImporter(DocumentImporter):
    def __init__(
        self,
        version: str,
        max_pages: int | None = None,
        delay: float = 1.0,
    ):
        super().__init__(version, "postgis_pages", "postgis_chunks")
        self.max_pages = max_pages
        self.delay = delay
        self.base_url = f"{POSTGIS_BASE_URL}/manual-{version}/"
        self.session = requests.Session()
        self.session.headers.update(
            {"User-Agent": "Mozilla/5.0 (compatible; PostGISDocsScraper/1.0)"}
        )
        self.processed_urls: set[str] = set()

    def get_pages(self) -> Iterable[PageSource]:
        for page_url in get_postgis_page_urls(self.session, self.base_url, self.max_pages):
            print(f"\nProcessing: {page_url}")
            full_url = urljoin(self.base_url, page_url)
            soup = fetch_page_as_soup(self.session, full_url, self.processed_urls, self.delay)
            if soup is None:
                continue

            title = extract_title(soup, fallback="PostGIS Documentation")
            soup = clean_postgis_html(soup)
            markdown = postgis_html_to_markdown(soup)

            page = Page(
                id=0,
                version=self.version,
                url=urljoin(self.base_url, page_url),
                domain=POSTGIS_DOMAIN,
                filename=page_url,
                title=title,
            )

            print(f"  Title: {title}")
            yield PageSource(
                page=page,
                lines=markdown.split("\n"),
                initial_header=title,
                initial_header_path=[title],
            )


def main():
    parser = argparse.ArgumentParser(
        description="Ingest PostGIS documentation into the database.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --version 3.5 --max-pages 10
  %(prog)s --version 3.5
  %(prog)s --version 3.4
        """,
    )

    parser.add_argument(
        "--version",
        "-v",
        required=True,
        help="PostGIS version to ingest (e.g., 3.5, 3.4)",
    )

    parser.add_argument(
        "--max-pages",
        "-m",
        type=int,
        help="Maximum number of pages to process",
    )

    parser.add_argument(
        "--delay",
        "-d",
        type=float,
        default=1.0,
        help="Delay between requests in seconds (default: 1.0)",
    )

    parser.add_argument(
        "--database-uri",
        help="PostgreSQL connection URI (default: from environment)",
    )

    args = parser.parse_args()

    db_uri = args.database_uri or build_database_uri()
    if not db_uri:
        print("Error: Database URI is required")
        print(
            "Set environment variables: DB_URL or (PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE)"
        )
        return 1

    importer = PostGISDocsImporter(
        version=args.version,
        max_pages=args.max_pages,
        delay=args.delay,
    )

    with psycopg.connect(db_uri) as conn:
        importer.run(conn)

    return 0


if __name__ == "__main__":
    exit(main())

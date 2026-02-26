import argparse
import os
import re
import shutil
import subprocess
from collections.abc import Iterable
from pathlib import Path
from urllib.parse import quote

import psycopg
from bs4 import BeautifulSoup
from ingest.document_importer import DocumentImporter, PageSource
from ingest.constants import BUILD_DIR, POSTGRES_BASE_URL, THIS_DIR
from ingest.types import Page
from ingest.utils.beautiful_soup import (
    extract_postgres_page_metadata,
    postgres_html_to_markdown,
)

POSTGRES_DIR = THIS_DIR / "postgres"
SMGL_DIR = POSTGRES_DIR / "doc" / "src" / "sgml"
HTML_DIR = SMGL_DIR / "html"
MD_DIR = BUILD_DIR / "md"


def update_repo():
    if not POSTGRES_DIR.exists():
        subprocess.run(
            "git clone https://github.com/postgres/postgres.git postgres",
            shell=True,
            check=True,
            env=os.environ,
            text=True,
            cwd=THIS_DIR,
        )
    else:
        subprocess.run(
            "git fetch",
            shell=True,
            check=True,
            env=os.environ,
            text=True,
            cwd=POSTGRES_DIR,
        )


def get_version_tag(version: int) -> str:
    result = subprocess.run(
        ["git", "tag", "-l"], capture_output=True, text=True, cwd=POSTGRES_DIR
    )
    if result.returncode != 0:
        raise RuntimeError("Failed to get git tags")

    tags = result.stdout.splitlines()

    candidate_tags = []

    for version_type in ["", "RC", "BETA"]:
        pattern = re.compile(rf"REL_{version}_{version_type}(\d+)$")
        for tag in tags:
            match = pattern.match(tag)
            if match:
                minor_version = int(match.group(1))
                candidate_tags.append((minor_version, tag))
        if len(candidate_tags) > 0:
            break

    if not candidate_tags:
        raise ValueError(f"No tags found for Postgres version {version}")

    candidate_tags.sort(key=lambda x: x[0], reverse=True)
    return candidate_tags[0][1]


def checkout_tag(tag: str) -> None:
    print(f"checking out {tag}...")
    subprocess.run(
        f"git checkout {tag}",
        shell=True,
        check=True,
        env=os.environ,
        text=True,
        cwd=POSTGRES_DIR,
    )


def build_html() -> None:
    html_stamp = SMGL_DIR / "html-stamp"

    # make uses the presence of html-stamp to determine if it needs to
    # rebuild the html docs.
    if html_stamp.exists():
        html_stamp.unlink()

    if HTML_DIR.exists():
        shutil.rmtree(HTML_DIR)

    print("configuring postgres build...")
    environ = os.environ.copy()
    # Shim for macOS and icu4c installed via homebrew, where it's not linked into
    # /usr/local by default.
    if Path("/opt/homebrew/opt/icu4c/lib/pkgconfig").exists():
        environ["PKG_CONFIG_PATH"] = "/opt/homebrew/opt/icu4c/lib/pkgconfig"

    # Shim for macOS and docbook installed via homebrew
    if Path("/opt/homebrew/etc/xml/catalog").exists():
        environ["XML_CATALOG_FILES"] = "/opt/homebrew/etc/xml/catalog"

    subprocess.run(
        "./configure --without-readline --without-zlib",
        shell=True,
        check=True,
        env=environ,
        text=True,
        cwd=POSTGRES_DIR,
    )

    print("building postgres docs...")
    subprocess.run(
        "make html",
        shell=True,
        check=True,
        env=environ,
        text=True,
        cwd=SMGL_DIR,
    )


def build_markdown() -> None:
    print("converting to markdown...")
    if MD_DIR.exists():
        shutil.rmtree(MD_DIR)
    MD_DIR.mkdir()

    for html_file in HTML_DIR.glob("*.html"):
        # Skip files which are more metadata about the docs than actual docs
        # that people would ask questions about.
        if html_file.name in [
            "legalnotice.html",
            "appendix-obsolete.md",
            "appendixes.md",
            "biblio.html",
            "bookindex.html",
            "bug-reporting.html",
            "source-format.html",
            "error-message-reporting.html",
            "error-style-guide.html",
            "source-conventions.html",
            "sourcerepo.html",
        ] or html_file.name.startswith("docguide"):
            continue
        md_file = MD_DIR / (html_file.stem + ".md")

        html_content = html_file.read_text(encoding="utf-8")
        html_content = html_content.replace(
            '<?xml version="1.0" encoding="UTF-8" standalone="no"?>', ""
        )

        soup = BeautifulSoup(html_content, "html.parser")
        try:
            title_text, slug, is_refentry = extract_postgres_page_metadata(soup)
        except SystemError:
            raise SystemError(f"No div with id found in {html_file}")

        md_content = postgres_html_to_markdown(soup, is_refentry)
        md_content = f"""---
title: {title_text}
slug: {slug}
refentry: {is_refentry}
---
{md_content}"""
        md_file.write_text(md_content, encoding="utf-8")


_SECTION_PREFIX = re.compile(r"^[A-Za-z0-9.]+\.\s*")
_CHAPTER_PREFIX = re.compile(r"^Chapter\s+[0-9]+\.\s*")


def _header_transform(header: str) -> str:
    header = re.sub(_SECTION_PREFIX, "", header).strip()
    header = re.sub(_CHAPTER_PREFIX, "", header).strip()
    return header


class PostgresDocsImporter(DocumentImporter):
    def __init__(self, version: int):
        super().__init__(version, "postgres_pages", "postgres_chunks")

    def get_pages(self) -> Iterable[PageSource]:
        for md in MD_DIR.glob("*.md"):
            print(f"chunking {md}...")
            f = md.open()
            # process the frontmatter
            f.readline()
            f.readline()  # title line
            slug = f.readline().split(":", 1)[1].strip()
            refentry = f.readline().split(":", 1)[1].strip().lower() == "true"
            f.readline()

            page = Page(
                id=0,
                version=self.version,
                url=f"{POSTGRES_BASE_URL}/{self.version}/{slug}",
                domain="postgresql.org",
                filename=md.name,
            )
            yield PageSource(
                page=page,
                lines=f,
                refentry=refentry,
                header_transform=_header_transform,
            )
            f.close()


def main():
    parser = argparse.ArgumentParser(
        description="Ingest Postgres documentation into the database."
    )
    parser.add_argument("version", type=int, help="Postgres version to ingest")
    args = parser.parse_args()
    version = args.version
    update_repo()
    tag = get_version_tag(version)
    # URL-encode password to handle special characters like '@'
    encoded_password = quote(os.environ["PGPASSWORD"], safe="")
    db_uri = f"postgresql://{os.environ['PGUSER']}:{encoded_password}@{os.environ['PGHOST']}:{os.environ['PGPORT']}/{os.environ['PGDATABASE']}"
    with psycopg.connect(db_uri) as conn:
        print(f"Building Postgres {version} ({tag}) documentation...")
        checkout_tag(tag)
        build_html()
        build_markdown()
        PostgresDocsImporter(version).run(conn)


if __name__ == "__main__":
    main()

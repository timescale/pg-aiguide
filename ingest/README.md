# Ingest

## Setup

### Prerequisites

- [`uv`](https://docs.astral.sh/uv/)
- Docbook Toolsets for building PostgreSQL docs
  (see [this page](https://www.postgresql.org/docs/current/docguide-toolsets.html)
  for installing for specific platforms)

### Install Dependencies

```bash
uv sync
```

## Linting and formatting

Python code is formatted and linted with [`ruff`](https://docs.astral.sh/ruff/),
configured in `pyproject.toml`. The repo-root `./check` script runs both (and
auto-fixes what it can), so normally you just run:

```bash
./check
```

To run them directly:

```bash
uv run ruff format .            # format
uv run ruff format --check .    # verify formatting, as CI does
uv run ruff check .             # lint
uv run ruff check --fix .       # lint and apply safe fixes
```

CI enforces `ruff format --check`, `ruff check`, and `uv lock --check` in the
`Lint Python` job. `ruff` lives in the `dev` dependency group, so the ingest
workflows install with `uv sync --no-dev`.

After changing dependencies, commit the regenerated `uv.lock`, or `uv lock
--check` will fail in CI.

There is no type checker configured for this code. `ruff` is the only Python
tool that CI enforces.

## Running the ingest in CI

The `Ingest Docs` workflow ingests every source, and runs weekly on a schedule.
To start it by hand, use the Actions tab or the CLI:

```bash
# Everything, dev and prod. Same as the weekly run.
gh workflow run ingest-docs.yaml

# One source, every version of it.
gh workflow run ingest-docs.yaml -f source=postgres

# Specific versions.
gh workflow run ingest-docs.yaml -f source=postgres -f versions=17,18
gh workflow run ingest-docs.yaml -f source=postgis -f versions=3.6

# One environment only.
gh workflow run ingest-docs.yaml -f source=tiger -f environment=dev
```

Ingests of one source overwrite each other's `_tmp` tables, so the workflow runs
them one at a time (`max-parallel: 1`), and a `concurrency` group stops two runs
of the workflow from overlapping. The dev and prod jobs run at the same time,
because they write different databases. `fail-fast: false` means one bad version
does not stop the rest.

The version lists live in `.github/scripts/plan_ingest.py`. Keep them in step
with the `source` enum in `src/apis/searchDocs.ts`.

## Running the ingest locally

### PostgreSQL Documentation

```text
$ uv run python postgres_docs.py --help
usage: postgres_docs.py [-h] version

Ingest Postgres documentation into the database.

positional arguments:
  version     Postgres version to ingest

options:
  -h, --help  show this help message and exit
```

### Tiger Documentation

```text
uv run python tiger_docs.py --help
usage: tiger_docs.py [-h] [--domain DOMAIN] [-o OUTPUT_DIR] [-m MAX_PAGES] [--strip-images] [--no-strip-images] [--chunk] [--no-chunk] [--chunking {header,semantic}] [--storage-type {file,database}] [--database-uri DATABASE_URI]
                         [--skip-indexes] [--delay DELAY] [--concurrent CONCURRENT] [--log-level {DEBUG,INFO,WARNING,ERROR}] [--user-agent USER_AGENT]

Scrape websites using sitemaps and convert to chunked markdown for RAG applications

options:
  -h, --help            show this help message and exit
  --domain, -d DOMAIN   Domain to scrape (e.g., docs.tigerdata.com)
  -o, --output-dir OUTPUT_DIR
                        Output directory for scraped files (default: scraped_docs)
  -m, --max-pages MAX_PAGES
                        Maximum number of pages to scrape (default: unlimited)
  --strip-images        Strip data: images from content (default: True)
  --no-strip-images     Keep data: images in content
  --chunk               Enable content chunking (default: True)
  --no-chunk            Disable content chunking
  --chunking {header,semantic}
                        Chunking method: header (default) or semantic (requires OPENAI_API_KEY)
  --storage-type {file,database}
                        Storage type: database (default) or file
  --database-uri DATABASE_URI
                        PostgreSQL connection URI (default: uses DB_URL from environment)
  --skip-indexes        Skip creating database indexes after import (for development/testing)
  --delay DELAY         Download delay in seconds (default: 1.0)
  --concurrent CONCURRENT
                        Maximum concurrent requests (default: 4)
  --log-level {DEBUG,INFO,WARNING,ERROR}
                        Logging level (default: INFO)
  --user-agent USER_AGENT
                        User agent string

Examples:
  tiger_docs.py docs.tigerdata.com
  tiger_docs.py docs.tigerdata.com -o tiger_docs -m 50
  tiger_docs.py docs.tigerdata.com -o semantic_docs -m 5 --chunking semantic
  tiger_docs.py docs.tigerdata.com --no-chunk --no-strip-images -m 100
  tiger_docs.py docs.tigerdata.com --storage-type database --database-uri postgresql://user:pass@host:5432/dbname
  tiger_docs.py docs.tigerdata.com --storage-type database --chunking semantic -m 10
```

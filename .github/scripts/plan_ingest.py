#!/usr/bin/env python3
"""Build the job matrix for the ingest workflow.

Prints a JSON list of matrix entries. Each entry runs one ingest command for
one source, and one version when the source has versions.

Keep the version lists here in step with the `source` enum in
`src/apis/searchDocs.ts`.
"""

import argparse
import json
import sys

# Slowest source last, so a mistake in a fast source shows up early.
POSTGIS_VERSIONS = ["3.3", "3.4", "3.5", "3.6"]
POSTGRES_VERSIONS = ["14", "15", "16", "17", "18"]

SOURCE_ORDER = ["tiger", "postgis", "postgres"]
VERSIONS_BY_SOURCE = {
    "tiger": [],
    "postgis": POSTGIS_VERSIONS,
    "postgres": POSTGRES_VERSIONS,
}


def build_entry(source: str, version: str) -> dict:
    """Build one matrix entry for a source and version."""
    if source == "tiger":
        return {"source": source, "label": "tiger", "command": "tiger_docs.py"}
    if source == "postgis":
        return {
            "source": source,
            "label": f"postgis {version}",
            "command": f"postgis_docs.py --version {version}",
        }
    return {
        "source": source,
        "label": f"postgres {version}",
        "command": f"postgres_docs.py {version}",
    }


def resolve_versions(source: str, requested: list[str]) -> list[str]:
    """Return the versions to ingest for one source, and reject unknown ones."""
    supported = VERSIONS_BY_SOURCE[source]
    if not supported:
        # Tiger has no versions. Asking for one is a mistake worth reporting.
        if requested:
            raise ValueError(f"source '{source}' does not take versions: {requested}")
        return [""]
    if not requested:
        return supported
    unknown = [v for v in requested if v not in supported]
    if unknown:
        raise ValueError(
            f"unknown {source} version(s): {', '.join(unknown)}. "
            f"Supported: {', '.join(supported)}"
        )
    # Keep the declared order, so runs are predictable.
    return [v for v in supported if v in requested]


def plan(source: str, versions: str) -> list[dict]:
    """Build the full matrix for the requested source and versions."""
    requested = [v.strip() for v in versions.split(",") if v.strip()]

    if source == "all":
        if requested:
            raise ValueError("versions cannot be combined with source 'all'")
        sources = SOURCE_ORDER
    elif source in VERSIONS_BY_SOURCE:
        sources = [source]
    else:
        raise ValueError(f"unknown source: {source}")

    return [
        build_entry(s, version)
        for s in sources
        for version in resolve_versions(s, requested)
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="all")
    parser.add_argument("--versions", default="")
    args = parser.parse_args()

    try:
        entries = plan(args.source, args.versions)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    print(json.dumps(entries))
    return 0


if __name__ == "__main__":
    sys.exit(main())

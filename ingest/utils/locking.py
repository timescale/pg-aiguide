import zlib

import psycopg

# One lock guards all ingest jobs that stage into the same pair of _tmp tables.
# The namespace keeps the keys away from other advisory lock users.
_INGEST_LOCK_NAMESPACE = 0x70676169  # "pgai"


def _lock_key(pages_table: str) -> int:
    """Build the advisory lock key for a set of ingest tables.

    Uses crc32, because the built-in hash() of a string changes between
    processes, and every job must calculate the same key.
    """
    return _INGEST_LOCK_NAMESPACE ^ zlib.crc32(pages_table.encode())


def acquire_ingest_lock(conn: psycopg.Connection, pages_table: str) -> None:
    """Take the ingest lock, and wait when another ingest job holds it.

    The `_tmp` tables have fixed names and hold a copy of every other version,
    so two ingest jobs that overlap either fail on a duplicate key or silently
    discard the version that finished first. This lock makes the jobs run one
    after the other.

    The lock is session level, so it stays after each `COMMIT`, and Postgres
    releases it when the connection closes.
    """
    key = _lock_key(pages_table)
    got_lock = conn.execute("SELECT pg_try_advisory_lock(%s)", [key]).fetchone()
    assert got_lock is not None
    if not got_lock[0]:
        print(
            f"Another ingest job is running for {pages_table}. "
            "Waiting for it to finish..."
        )
        conn.execute("SELECT pg_advisory_lock(%s)", [key])
    print(f"Holding ingest lock for {pages_table}.")

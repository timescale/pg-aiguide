import os
from typing import Optional
from urllib.parse import quote


def build_database_uri() -> Optional[str]:
    db_url = os.environ.get("DB_URL")
    if db_url:
        return db_url

    pg_user = os.environ.get("PGUSER")
    pg_password = os.environ.get("PGPASSWORD")
    pg_host = os.environ.get("PGHOST")
    pg_port = os.environ.get("PGPORT")
    pg_database = os.environ.get("PGDATABASE")

    if all([pg_user, pg_password, pg_host, pg_port, pg_database]):
        encoded_password = quote(pg_password, safe="")
        return f"postgresql://{pg_user}:{encoded_password}@{pg_host}:{pg_port}/{pg_database}"

    return None

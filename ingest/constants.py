import os
from pathlib import Path

from dotenv import load_dotenv

THIS_DIR = Path(__file__).parent.resolve()
load_dotenv(dotenv_path=THIS_DIR.parent / ".env")


BUILD_DIR = THIS_DIR / "build"
BUILD_DIR.mkdir(exist_ok=True)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL")  # Optional: custom API endpoint
EMBEDDING_MODEL = os.getenv(
    "EMBEDDING_MODEL", "text-embedding-3-small"
)  # Default model

MAX_CHUNK_TOKENS = 7000
EMBEDDING_DIMENSIONS = 1536  # Fixed to match database schema


POSTGRES_BASE_URL = "https://www.postgresql.org/docs"
POSTGIS_BASE_URL = "https://postgis.net/docs"
POSTGIS_DOMAIN = "postgis.net"

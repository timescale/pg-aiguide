import os
from pathlib import Path

from dotenv import load_dotenv

THIS_DIR = Path(__file__).parent.resolve()
load_dotenv(dotenv_path=THIS_DIR.parent / ".env")


BUILD_DIR = THIS_DIR / "build"
BUILD_DIR.mkdir(exist_ok=True)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Bare OpenAI model name, with any "openai/" prefix stripped so the env var can
# be given either way. Use this for tiktoken and for logging.
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small").removeprefix(
    "openai/"
)

# Model id to send with embedding requests. OpenRouter namespaces models by
# upstream provider, so it needs the "openai/" prefix; OpenAI itself does not.
EMBEDDING_MODEL_ID = (
    f"openai/{EMBEDDING_MODEL}" if OPENROUTER_API_KEY else EMBEDDING_MODEL
)

MIN_CHUNK_TOKENS = 10  # anything less provides no value
MAX_CHUNK_TOKENS = 8191
EMBEDDING_DIMENSIONS = 1536  # Fixed to match database schema


POSTGRES_BASE_URL = "https://www.postgresql.org/docs"
POSTGIS_BASE_URL = "https://postgis.net/docs"
POSTGIS_DOMAIN = "postgis.net"

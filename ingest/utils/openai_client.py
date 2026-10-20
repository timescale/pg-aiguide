import openai
from ingest.constants import OPENAI_API_KEY, OPENROUTER_API_KEY, OPENROUTER_BASE_URL


def make_openai_client() -> openai.OpenAI:
    """Build the OpenAI SDK client, routed through OpenRouter when its key is set.

    Pair this with EMBEDDING_MODEL_ID, which carries the matching model prefix.
    """
    if OPENROUTER_API_KEY:
        return openai.OpenAI(api_key=OPENROUTER_API_KEY, base_url=OPENROUTER_BASE_URL)
    if not OPENAI_API_KEY:
        raise ValueError(
            "OPENAI_API_KEY or OPENROUTER_API_KEY must be set to generate embeddings"
        )
    return openai.OpenAI(api_key=OPENAI_API_KEY)

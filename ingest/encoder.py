import tiktoken

from ingest.constants import EMBEDDING_MODEL

ENC = tiktoken.encoding_for_model(EMBEDDING_MODEL)

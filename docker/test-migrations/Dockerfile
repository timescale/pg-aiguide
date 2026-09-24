FROM pgvector/pgvector:0.8.6-pg18-trixie

ARG TARGETARCH
ARG PG_TEXTSEARCH_VERSION=1.4.0

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && curl -fSL "https://github.com/timescale/pg_textsearch/releases/download/v${PG_TEXTSEARCH_VERSION}/pg-textsearch-v${PG_TEXTSEARCH_VERSION}-pg18-${TARGETARCH}.zip" -o /tmp/pg-textsearch.zip \
    && unzip -q /tmp/pg-textsearch.zip -d /tmp/pg-textsearch \
    && apt-get install -y --no-install-recommends /tmp/pg-textsearch/*.deb \
    && rm -rf /tmp/pg-textsearch /tmp/pg-textsearch.zip /var/lib/apt/lists/*

# BM25 indexes need pg_textsearch preloaded before migrations run.
CMD ["postgres", "-c", "shared_preload_libraries=pg_textsearch"]

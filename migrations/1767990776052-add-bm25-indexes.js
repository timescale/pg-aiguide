import 'dotenv/config';
import { Client } from 'pg';

const schema = process.env.DB_SCHEMA || 'docs';

export const description = 'Add pg_textsearch + BM25 indexes on docs content';

export async function up() {
  const client = new Client();

  try {
    await client.connect();

    await client.query(/* sql */ `
      CREATE EXTENSION IF NOT EXISTS pg_textsearch;
    `);

    await client.query(/* sql */ `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS timescale_chunks_content_idx
      ON ${schema}.timescale_chunks
      USING bm25(content) WITH (text_config='english');
    `);

    await client.query(/* sql */ `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS postgres_chunks_content_idx
      ON ${schema}.postgres_chunks
      USING bm25(content) WITH (text_config='english');
    `);
  } finally {
    await client.end();
  }
}

export async function down() {
  const client = new Client();

  try {
    await client.connect();

    await client.query(/* sql */ `
      DROP INDEX CONCURRENTLY IF EXISTS ${schema}.timescale_chunks_content_idx;
    `);

    await client.query(/* sql */ `
      DROP INDEX CONCURRENTLY IF EXISTS ${schema}.postgres_chunks_content_idx;
    `);
  } finally {
    await client.end();
  }
}

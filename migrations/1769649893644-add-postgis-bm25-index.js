import 'dotenv/config';
import { Client } from 'pg';

const schema = process.env.DB_SCHEMA || 'docs';

export const description = 'Add BM25 index on PostGIS docs content';

export async function up() {
  const client = new Client();

  try {
    await client.connect();

    await client.query(/* sql */ `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS postgis_chunks_content_idx
      ON ${schema}.postgis_chunks
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
      DROP INDEX CONCURRENTLY IF EXISTS ${schema}.postgis_chunks_content_idx;
    `);
  } finally {
    await client.end();
  }
}

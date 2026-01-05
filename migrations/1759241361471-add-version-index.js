import 'dotenv/config';
import { Client } from 'pg';

const schema = process.env.DB_SCHEMA || 'docs';

export const description = 'Add index on postgres_pages.version';

export async function up() {
  const client = new Client();

  try {
    await client.connect();
    await client.query(/* sql */ `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS postgres_pages_version_idx
      ON ${schema}.postgres_pages (version);
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
      DROP INDEX CONCURRENTLY IF EXISTS ${schema}.postgres_pages_version_idx;
    `);
  } finally {
    await client.end();
  }
}

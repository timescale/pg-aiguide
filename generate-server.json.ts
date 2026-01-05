import { writeFile } from 'node:fs/promises';

const version = process.argv[2]?.trim().replace(/^v/, '');
if (!version) {
  console.error('Must provide version as first argument');
  process.exit(1);
}

const environmentVariables = [
  {
    description: 'Your API key for text embeddings via OpenAI',
    isRequired: true,
    format: 'string',
    isSecret: true,
    name: 'OPENAI_API_KEY',
  },
  {
    description: 'PostgreSQL host to connect to',
    isRequired: true,
    format: 'string',
    isSecret: true,
    name: 'PGHOST',
  },
  {
    description: 'PostgreSQL port to connect to',
    isRequired: true,
    format: 'number',
    isSecret: true,
    name: 'PGPORT',
  },
  {
    description: 'PostgreSQL user to connect as',
    isRequired: true,
    format: 'string',
    isSecret: true,
    name: 'PGUSER',
  },
  {
    description: 'PostgreSQL password to connect with',
    isRequired: true,
    format: 'string',
    isSecret: true,
    name: 'PGPASSWORD',
  },
  {
    description: 'PostgreSQL database to connect to',
    isRequired: true,
    format: 'string',
    isSecret: true,
    name: 'PGDATABASE',
  },
  {
    description: 'PostgreSQL database schema to use',
    isRequired: false,
    format: 'string',
    isSecret: true,
    name: 'DB_SCHEMA',
  },
];

const output = {
  $schema:
    'https://static.modelcontextprotocol.io/schemas/2025-10-17/server.schema.json',
  name: 'io.github.timescale/pg-aiguide',
  // max length 100 chars:
  description:
    'Comprehensive PostgreSQL documentation and best practices, including ecosystem tools',
  repository: {
    url: 'https://github.com/timescale/pg-aiguide',
    source: 'github',
  },
  version,
  remotes: [
    {
      type: 'streamable-http',
      url: 'https://mcp.tigerdata.com/docs',
    },
  ],
  packages: [
    {
      registryType: 'npm',
      identifier: '@tigerdata/pg-aiguide',
      version,
      transport: {
        type: 'stdio',
      },
      environmentVariables,
    },
    {
      registryType: 'oci',
      identifier: `ghcr.io/timescale/pg-aiguide:${version}`,
      transport: {
        type: 'stdio',
      },
      environmentVariables,
    },
  ],
};

await writeFile('server.json', JSON.stringify(output, null, 2));

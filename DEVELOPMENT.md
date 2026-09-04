# Development Guide

## Getting Started

Clone the repo.

```bash
git clone git@github.com:timescale/pg-aiguide.git
```

## Configuration

Create a `.env` file based on the `.env.sample` file.

```bash
cp .env.sample .env
```

Add your OPENAI_API_KEY to be used for generating embeddings.

### Configuration Parameters

The server supports disabling MCP skills through different mechanisms for each transport:

#### HTTP Transport

Pass parameters as query strings:

```
https://mcp.tigerdata.com/docs?disable_mcp_skills=1
```

#### Stdio Transport

Use environment variables in the connection configuration:

```json
{
  "mcpServers": {
    "pg-aiguide": {
      "command": "node",
      "args": ["/path/to/dist/index.js", "stdio"],
      "env": {
        "DISABLE_MCP_SKILLS": "1"
      }
    }
  }
}
```

Or when running directly:

```bash
DISABLE_MCP_SKILLS=1 node dist/index.js stdio
```

#### Available Parameters

| Parameter          | HTTP Query           | Stdio Env Var        | Values    | Description                                                                                                                                                   |
| ------------------ | -------------------- | -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disable MCP Skills | `disable_mcp_skills` | `DISABLE_MCP_SKILLS` | 1 or true | Disable all MCP skills (tools and prompt templates). This removes the `view_skill` tool and all skill-based prompt templates from the available capabilities. |

**Examples:**

- HTTP: `?disable_mcp_skills=1`
- Stdio: `DISABLE_MCP_SKILLS=1`
- Default (skills enabled): No parameter needed

## Run a TimescaleDB Database

You will need a database with the [pgvector extension](https://github.com/pgvector/pgvector).

### Using Tiger Cloud

Use the [tiger CLI](https://github.com/timescale/tiger-cli) to create a Tiger Cloud service.

```bash
tiger service create --free --with-password -o json
```

Copy your database connection parameters into your .env file.

### Using Docker

Run the database in a docker container.

```bash
# pull the latest image
docker pull timescale/timescaledb-ha:pg17

# run the database container
docker run -d --name pg-aiguide \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=tsdb \
  -e POSTGRES_USER=tsdbadmin \
  -p 127.0.0.1:5432:5432 \
  timescale/timescaledb-ha:pg17
```

Copy your database connection parameters to your .env file:

```dotenv
PGHOST=localhost
PGPORT=5432
PGDATABASE=tsdb
PGUSER=tsdbadmin
PGPASSWORD=password
```

## Building the MCP Server

Run `./bun i` to install dependencies and build the project. Use `./bun run watch http` to rebuild on changes.

## TypeScript

We compile with [TypeScript 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/),
the native (Go) port, which is roughly 10x faster than 6.x. `tsc` (used by
`build` and `typecheck`) is 7.x.

TypeScript 7.0 ships **no programmatic API**, so if we ever add tooling that
imports the compiler as a library (`typescript-eslint`, or editor language
services for Vue/Svelte/Astro/MDX), it will need 6.x installed alongside. The
release notes describe how to do that with npm aliases: 7.x under
`@typescript/native` and 6.x under the `typescript` name that such tools resolve
through. We don't need it today — nothing here imports the compiler API, and we
lint with biome rather than eslint.

VS Code needs the [TypeScript 7 extension](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview)
for the new language server; it discovers 7.x from `node_modules` automatically.
Support is expected to ship in VS Code itself.

## Loading the Database

The database is NOT preloaded with the documentation. To make the MCP server usable, you need to scrape, chunk, embed, load, and index the documentation.
Follow the [directions in the ingest directory](/ingest/README.md) to load the database.

## Testing

The MCP Inspector is a very handy to exercise the MCP server from a web-based UI.

```bash
./bun run inspector
```

| Field          | Value           |
| -------------- | --------------- |
| Transport Type | `STDIO`         |
| Command        | `node`          |
| Arguments      | `dist/index.js` |

### Testing in Claude Desktop

Create/edit the file `~/Library/Application Support/Claude/claude_desktop_config.json` to add an entry like the following, making sure to use the absolute path to your local `pg-aiguide` project, and real database credentials.

```json
{
  "mcpServers": {
    "pg-aiguide": {
      "command": "node",
      "args": ["/absolute/path/to/pg-aiguide/dist/index.js", "stdio"],
      "env": {
        "PGHOST": "x.y.tsdb.cloud.timescale.com",
        "PGDATABASE": "tsdb",
        "PGPORT": "32467",
        "PGUSER": "readonly_mcp_user",
        "PGPASSWORD": "abc123",
        "DB_SCHEMA": "docs",
        "OPENAI_API_KEY": "sk-svcacct"
      }
    }
  }
}
```

## Releasing

Releases are cut with the release script. Don't create the tag or release in
the GitHub UI. The version is hard-coded in `package.json`,
`.claude-plugin/marketplace.json`, and `.cursor-plugin/plugin.json`, and npm
rejects a publish whose `package.json` version already exists, so a tag pushed
without the bump fails CI and burns the version number.

Run `./bun i` first, then:

```bash
./bun release 0.7.0   # explicit version
./bun release patch   # or: major | minor | patch, relative to package.json
```

The script:

1. Checks that the working tree is clean, you are on `main`, local `main` is
   not behind `origin/main`, the version is valid semver and greater than the
   current one, and the tag does not already exist.
2. Writes the new version into the three files above.
3. Commits them as `release: vX.Y.Z`, creates an annotated `vX.Y.Z` tag, and
   runs `git push --follow-tags`.

The tag push triggers the Publish workflow (`.github/workflows/publish.yml`),
which publishes to npm, Docker Hub, ghcr.io, and the MCP Registry, then posts
to Slack. Create the GitHub Release from the existing tag afterward if you want
release notes.

**You need permission to push directly to `main`.** The repository rule
requiring pull requests blocks the commit push but not the tag push, which
leaves the tag published and CI running while `main` still has the old version.
If that happens, push the local release commit to `main` with admin bypass so
the tag's commit is on `main`.

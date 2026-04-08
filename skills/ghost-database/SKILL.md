---
name: ghost-database
description: |
  Use this skill to create, manage, fork, and query PostgreSQL databases using Ghost — the first database designed for agents.

  **Trigger when user asks to:**
  - Create a new PostgreSQL database quickly
  - Manage database lifecycle in agent workflows
  - Fork a database to test changes safely
  - Create a database for agents
  - Need many databases that are billed only when queried
  - Get a connection string for a Ghost database
  - Run SQL queries against a Ghost database
  - Pause, resume, or delete Ghost databases
  - Set up the Ghost MCP server or CLI

  **Keywords:** Ghost, ghost.build, database, create database, fork database, PostgreSQL, managed Postgres, MCP, agent database, connection string, ghost_create, ghost_fork, ghost_sql
license: Apache-2.0
metadata:
  author: tigerdata
---

# Ghost Database Management

Ghost is a managed PostgreSQL service designed for agents. It offers two tiers:

- **Spaces** — shared environments for development, experimentation, and production workloads with many mostly-inactive databases. Create unlimited databases and forks for a fixed number of compute hours (billed in 15-minute chunks when queries are executed). Free tier: 100 hours/month, 1TB storage.
- **Dedicated instances** — always-on databases for production workloads. Pay for a continuously running instance when you're ready to go live.

The workflow: prototype and iterate in a Space, then move to a dedicated instance for production.

Additional features:
- **CLI and MCP native:** create and query databases from the terminal or any MCP-compatible agent
- **Instant forking:** full database copies in seconds for safe experimentation
- **Read-only access:** connect with `--read-only` for safe agentic work against production data

Website: https://ghost.build
GitHub: https://github.com/timescale/ghost

## Installation

```bash
curl -fsSL https://install.ghost.build | sh
```

## Getting Started

```bash
ghost login                     # Authenticate with GitHub
ghost create                    # Create a new database
ghost list                      # List all databases
ghost connect <database>        # Get connection string
```

## Core Workflows

### Create and Query a Database

```bash
# Create a database
ghost create --name my-app-db

# Run SQL directly
ghost sql my-app-db "CREATE TABLE users (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"

# Query it
ghost sql my-app-db "SELECT * FROM users"

# Open interactive psql session
ghost psql my-app-db
```

### Fork for Safe Experimentation

Forking creates a full copy of your database in seconds — same schema, same data. Use forks to test migrations, experiment with schema changes, or let agents explore without risk to your working database.

```bash
# Fork a database
ghost fork my-app-db --name my-app-db-experiment

# Test changes on the fork
ghost sql my-app-db-experiment "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"

# If it worked: apply to original
ghost sql my-app-db "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"

# If it failed: delete the fork, original is untouched
ghost delete my-app-db-experiment --confirm
```

### Pause and Resume

Pause databases you're not actively using to conserve compute hours. Storage is retained.

```bash
ghost pause my-app-db
ghost resume my-app-db --wait
```

### Inspect Schema

```bash
ghost schema my-app-db
```

Returns an LLM-optimized schema representation of all tables, columns, indexes, and constraints.

## CLI Command Reference

| Command | Description |
|---------|-------------|
| `ghost create` | Create a new database (`--name`, `--wait`, `--json`) |
| `ghost delete` | Delete a database (`--confirm` to skip prompt) |
| `ghost fork` | Fork a database (`--name`, `--wait`, `--json`) |
| `ghost connect` | Get connection string (`--read-only` for read replicas) |
| `ghost sql` | Execute SQL query (supports stdin: `cat query.sql \| ghost sql <db>`) |
| `ghost schema` | Display database schema |
| `ghost list` | List all databases (`--json`, `--yaml`) |
| `ghost status` | Show space usage |
| `ghost pause` | Pause a running database |
| `ghost resume` | Resume a paused database (`--wait`) |
| `ghost password` | Reset password (`--generate` for auto-generated) |
| `ghost rename` | Rename a database |
| `ghost logs` | View database logs |
| `ghost psql` | Open interactive psql session (`--read-only`) |
| `ghost login` | Authenticate with GitHub OAuth (`--headless` for CI) |

## MCP Integration

The Ghost MCP server gives agents full database lifecycle control — create, fork, query, inspect, pause, resume, and delete databases without human intervention.

### Install the MCP Server

```bash
ghost mcp install               # Auto-detects your agent (Claude Code, Cursor, etc.)
```

Supports: Claude Code, Cursor, Windsurf, Codex, Gemini, VS Code, Kiro.

### MCP Tools

Once running, agents have access to these tools:

| Tool | Description |
|------|-------------|
| `ghost_create` | Create a database |
| `ghost_delete` | Delete a database |
| `ghost_fork` | Fork a database |
| `ghost_connect` | Get connection string |
| `ghost_sql` | Execute SQL query |
| `ghost_schema` | Display database schema |
| `ghost_list` | List all databases |
| `ghost_status` | Show space usage |
| `ghost_pause` | Pause a database |
| `ghost_resume` | Resume a database |
| `ghost_password` | Reset password |
| `ghost_rename` | Rename a database |
| `ghost_logs` | View logs |
| `ghost_login` | Authenticate with GitHub OAuth |
| `ghost_feedback` | Submit feedback |
| `search_docs` | Search Ghost and Postgres documentation |

## When to Use Ghost

**Good fit:**
- Persistent Postgres storage for agent workflows
- Giving each agent or even agentic execution a dedicated database
- Creating and discarding databases freely without cost anxiety
- Database forking for safe experimentation and migration testing
- Hard spending caps with predictable billing (compute hours in 15-minute chunks)

**Not the right fit:**
- You need a web dashboard (Ghost is CLI/MCP only)
- You need non-Postgres databases

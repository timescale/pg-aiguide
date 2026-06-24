---
name: ghost-database
description: |
  Use this skill for persistent PostgreSQL storage in agent workflows — spin up databases on demand, test schema migrations safely on forks, and pass databases as assets between agents using Ghost.

  **Trigger when user asks to:**
  - Create a new PostgreSQL database quickly
  - Manage database lifecycle in agent workflows
  - Fork a database to test changes safely
  - Run analytics or heavy queries on a fork without impacting the production database
  - Share a database snapshot so others can spin up their own copy
  - Pass a database as an input or output between agents
  - Create a database for agents
  - Need many databases that are billed only when queried
  - Set up the Ghost MCP server or CLI

  **Note:** If the Ghost MCP server is already installed, use its tools directly — this skill is for environments without the  MCP  or as a reference for what's possible.

  **Keywords:** Ghost, ghost.build, database, create database, fork database, PostgreSQL, managed Postgres, MCP, agent database, connection string
license: Apache-2.0
metadata:
  author: tigerdata
---

# Ghost Database Management

Ghost is a managed PostgreSQL service designed for agents. Your account is organized into Spaces, each with unlimited on-demand databases and forks sharing a pool of compute hours (billed in 15-minute chunks when queries are executed). Free tier: 100 hours/month, 1TB storage.

When you need continuous operation, promote any database to a **dedicated instance** — a separately billed, always-on database.

Additional features:
- **CLI and MCP native:** create and query databases from the terminal or any MCP-compatible agent
- **Instant forking:** full database copies in seconds for safe experimentation
- **Shareable snapshots:** share a database snapshot via URL — anyone with the link can spin up their own copy in their own space
- **MCP read-only mode:** `ghost config set read_only true` locks all MCP tools into read-only — SQL queries execute in read-only mode and destructive tools (`ghost_delete`, `ghost_password`, `ghost_rename`) are blocked

Website: https://ghost.build

## Installation

Multiple installation methods are provided. If you aren't sure, use the first one.

### Install Script (macOS/Linux/WSL)

```bash
curl -fsSL https://install.ghost.build | sh
```

### Install Script (Windows PowerShell)

```powershell
irm https://install.ghost.build/install.ps1 | iex
```

### Debian/Ubuntu

```bash
curl -s https://packagecloud.io/install/repositories/timescale/ghost/script.deb.sh | sudo os=any dist=any bash
sudo apt-get install ghost
```

### Red Hat/Fedora

```bash
curl -s https://packagecloud.io/install/repositories/timescale/ghost/script.rpm.sh | sudo os=rpm_any dist=rpm_any bash
sudo yum install ghost
```

## Getting Started

**CLI**
```bash
ghost login                     # Authenticate with GitHub
ghost create                    # Create a new database (returns an ID, e.g. abc123)
ghost list                      # List all databases with their IDs
ghost connect <name-or-id>              # Get connection string
```

**MCP**
```
ghost_login()                   // Authenticate with GitHub
ghost_create({ name: "my-db" }) // → returns { id: "abc123", ... }
ghost_list()                    // List all databases with their IDs
ghost_connect({ name_or_id: "abc123" }) // Get connection string
```

## Core Workflows

### Create and Query a Database

**CLI**
```bash
# Create a database (returns an ID like abc123)
ghost create my-app-db

# Run SQL directly
ghost sql abc123 "CREATE TABLE users (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"

# Query it
ghost sql abc123 "SELECT * FROM users"

# Open interactive psql session
ghost psql abc123
```

**MCP**
```
ghost_create({ name: "my-app-db" })
// → returns { id: "abc123", ... }

ghost_sql({ name_or_id: "abc123", query: "CREATE TABLE users (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())" })

ghost_sql({ name_or_id: "abc123", query: "SELECT * FROM users" })
```

### Fork for Safe Experimentation

Forking creates a full copy of your database in seconds — same schema, same data. Use forks to test migrations, experiment with schema changes, or let agents explore without risk to your working database. You can fork a dedicated instance into an on-demand instance — useful for testing against a production copy without paying for always-on compute.

For a complete migration testing workflow using forks — including pre/post validation queries and rollback planning — see the `postgres-database-migration` skill.

**CLI**
```bash
# Fork a database (returns the fork's ID, e.g. def456)
ghost fork abc123 my-app-db-experiment

# Test changes on the fork
ghost sql my-app-db-experiment "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"

# If it worked: apply to original
ghost sql abc123 "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"

# If it failed: delete the fork, original is untouched
ghost delete my-app-db-experiment --confirm
```

**MCP**
```
ghost_fork({ name_or_id: "abc123", name: "my-app-db-experiment" })
// → returns { id: "def456", ... }

ghost_sql({ name_or_id: "def456", query: "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'" })

// If it worked: apply to original
ghost_sql({ name_or_id: "abc123", query: "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'" })

// If it failed: delete the fork, original is untouched
ghost_delete({ name_or_id: "def456" })
```

### Auto-Pause and Resume

Databases automatically pause after 30 days of idle time to conserve compute hours. Storage is retained. Resume a paused database when you need it again:

**CLI**
```bash
ghost resume abc123 --wait
```

**MCP**
```
ghost_resume({ name_or_id: "abc123" })
```

### Inspect Schema

**CLI**
```bash
ghost schema abc123
```

**MCP**
```
ghost_schema({ name_or_id: "abc123" })
```

Returns an LLM-optimized schema representation of all tables, columns, indexes, and constraints.

### Share a Database

Sharing creates a snapshot anyone can use to spin up their own copy — no access to your space required. Useful for sharing sample datasets, bug reproductions, or starter databases.

Agents can also use shares as a way to pass databases as assets: an agent can produce a database as output by sharing it (handing the recipient a URL to spin up their own copy), or accept a share token as input to start from a pre-populated database.

**CLI**
```bash
# Share a database (returns a share URL)
ghost share abc123

# Share with an expiry
ghost share abc123 --expires 24h

# Recipient creates their own database from the share token
ghost create --from-share <token>

# Manage shares
ghost share list abc123
ghost share revoke <token>
```

**MCP**
```
ghost_share({ name_or_id: "abc123" })
// → returns { share_token: "...", url: "..." }

ghost_share({ name_or_id: "abc123", expires: "24h" })

// Recipient creates their own database from the share token
ghost_create({ from_share: "<token>" })

// Manage shares
ghost_share_list()
ghost_share_revoke({ share_token: "<token>" })
```

## CLI Command Reference

For a full list of commands and flags, run:

```bash
ghost --help
ghost <command> --help   # e.g. ghost create --help
```

## MCP Integration

The Ghost MCP server gives agents full database lifecycle control — create, fork, query, inspect, resume, and delete databases without human intervention.

### Install the MCP Server

```bash
ghost mcp install 
```

Supports: Claude Code, Cursor, Windsurf, Codex, Gemini, VS Code, Kiro.

### MCP Read-Only Mode

To give agents safe read-only access, enable read-only mode before starting the MCP server:

```bash
ghost config set read_only true
```

This locks all MCP tools into read-only: `ghost_sql` executes queries in read-only mode, and destructive tools (`ghost_delete`, `ghost_password`, `ghost_rename`) are blocked entirely.


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

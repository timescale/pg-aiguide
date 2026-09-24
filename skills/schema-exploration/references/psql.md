# Running parameterized queries with `psql` (optional)

The reference queries are plain SQL with `$1`, `$2` placeholders. When using PostgreSQL **16+ `psql`**, enter the SQL without its final semicolon, then use `\bind` followed by `\g` to execute it with parameters. `\bind` applies only to the next execution. This is a `psql` convenience, not a requirement for other clients.

When the agent already knows the values, set them with `\set` in a `psql` session or pass them on the command line with `-v` (also spelled `--set`):

```text
\set schema_name postgres_air
\set relation_name flight
```

```sh
psql -X -v schema_name=postgres_air -v relation_name=flight -f query.sql
```

Quote shell arguments appropriately if values contain spaces or shell-special characters. Both methods define the same `psql` variables. Use `\prompt 'Schema: ' schema_name` **only** in an interactive script when a person should supply the value at run time.

Example for the [overview](overview.md) relation-list query (shortened here to illustrate the execution pattern), assuming `schema_name` was set by either method:

```text
select c.relname
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1
\bind :schema_name
\g
```

For a query with `$1` and `$2`, use `\bind :schema_name :relation_name`. In `\bind`, use `:variable` (the parameter value), **not** `:'variable'` (which includes SQL literal quotes in the bound value). `psql` 14–15 do **not** support `\bind`: use another client that binds parameters, or adapt the SQL for `psql` variable interpolation by replacing `$1` with `:'schema_name'` and `$2` with `:'relation_name'` (quoted as SQL **values**, not identifiers). For example, with `schema_name` already set:

```text
select n.nspname
from pg_catalog.pg_namespace n
where n.nspname = :'schema_name'
\g
```

Avoid raw `:schema_name` substitution. To construct a separate query against application table *data*, identifier substitution is a different problem: use `psql`'s `:"variable"` identifier quoting or your client's safe identifier-quoting facility. Never insert untrusted names into SQL unquoted.

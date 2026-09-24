# Foreign tables: what is local, what is remote?

Use this reference for a relation with `relkind = 'f'` in [overview](overview.md). A foreign table is a local catalog definition backed by a foreign data wrapper (FDW); it does not imply that rows are stored in this database. Start with metadata only. Do not query remote rows, invoke a foreign-table `ANALYZE`, or run `EXPLAIN ANALYZE` without approval: even a small `LIMIT` may trigger costly remote work. Queries below target PostgreSQL 18 and use catalog fields also present in PostgreSQL 14–17.

## FDW and server identity

`$1` = schema name, `$2` = foreign table name. Server/table options are listed by **name only**: option values and user mappings may contain connection details or credentials. Don't collect or report their values without explicit need and authorization. A `USAGE` privilege signal doesn't prove that a working user mapping exists or that the remote server is reachable.

```sql
select
  c.relname as foreign_table_name
, pg_catalog.pg_get_userbyid(c.relowner) as table_owner
, s.srvname as server_name
, pg_catalog.pg_get_userbyid(s.srvowner) as server_owner
, f.fdwname as wrapper_name
, pg_catalog.has_schema_privilege(n.oid, 'USAGE') as current_role_has_schema_usage
, pg_catalog.has_table_privilege(c.oid, 'SELECT') as current_role_has_table_select
, pg_catalog.has_server_privilege(s.oid, 'USAGE') as current_role_has_server_usage
, array(
    select pg_catalog.split_part(opt.option_text, '=', 1)
    from unnest(ft.ftoptions) as opt(option_text)
    order by 1
  ) as table_option_names
, array(
    select pg_catalog.split_part(opt.option_text, '=', 1)
    from unnest(s.srvoptions) as opt(option_text)
    order by 1
  ) as server_option_names
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_foreign_table ft on ft.ftrelid = c.oid
join pg_catalog.pg_foreign_server s on s.oid = ft.ftserver
join pg_catalog.pg_foreign_data_wrapper f on f.oid = s.srvfdw
where n.nspname = $1
  and c.relname = $2
  and c.relkind = 'f'
;
```

For column types and comments, start with [tables: columns](tables.md#columns). Column-level FDW options live in `pg_attribute.attfdwoptions` and can also contain sensitive values. To list **only their names**, use `$1` = schema name and `$2` = foreign table name:

```sql
select
  a.attname as column_name
, array(
    select pg_catalog.split_part(opt.option_text, '=', 1)
    from unnest(a.attfdwoptions) as opt(option_text)
    order by 1
  ) as column_option_names
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_attribute a on a.attrelid = c.oid
where n.nspname = $1
  and c.relname = $2
  and c.relkind = 'f'
  and a.attnum > 0
  and not a.attisdropped
order by a.attnum
;
```

The server name and wrapper type can suggest where to look for documentation, but not what the remote object contains. Foreign-table definitions may use table or column mappings whose names differ from remote names.

## Interpretation and boundaries

- Local `pg_class.reltuples` and `pg_total_relation_size` do **not** measure remote table size; local statistics may be absent, stale, or based on FDW-specific `ANALYZE` behavior. Never infer that a foreign table is empty because local bytes are zero.
- Local `NOT NULL`, `CHECK`, or other declarations do not prove remote enforcement or data quality. FDW behavior and remote permissions vary by wrapper and server configuration.
- Views and routines can depend on foreign tables. Follow [views](views.md) or [routines](routines.md) as needed, but reading a definition is different from executing it.
- Do not probe connection strings, user mappings, or remote data by default. If values or rows are necessary, agree on scope, sensitivity, and cost with the user first. [Data-derived values](data-values.md) requires approval and its `TABLESAMPLE` generator deliberately excludes foreign tables; plan an FDW-specific bounded query separately if authorized.

# Overview: find the relevant schema and object

## Contents

- [Context](#context)
- [Schema inventory](#schema-inventory)
- [Relations in one schema](#relations-in-one-schema)
- [Routines in one schema](#routines-in-one-schema)
- [User-defined triggers in one schema](#user-defined-triggers-in-one-schema)

Run the context query first. Do not inventory every object in a large database: start with schema counts, then restrict later queries to a chosen schema. Counts include extension-owned objects; consult [extensions](extensions.md) if they dominate the inventory. Queries target PostgreSQL 18 and use catalog columns also present in PostgreSQL 14–17.

## Context

No parameters.

```sql
select
  current_database() as database_name
, current_user as role_name
, current_setting('server_version_num')::integer as server_version_num
, current_setting('search_path') as search_path
, current_setting('transaction_read_only') as transaction_read_only
;
```

## Schema inventory

No parameters. Counts describe catalog objects, not only objects usable by the current role. `tables` counts ordinary and partitioned tables (including partition children); `foreign_tables` is separate because its data is accessed through a foreign server. Excludes built-in and temporary schemas; extension schemas may still appear.

```sql
select
  n.nspname as schema_name
, pg_catalog.has_schema_privilege(n.oid, 'USAGE') as current_role_has_schema_usage
, pg_catalog.obj_description(n.oid, 'pg_namespace') as comment
, count(c.oid) filter (where c.relkind in ('r', 'p')) as tables
, count(c.oid) filter (where c.relkind = 'f') as foreign_tables
, count(c.oid) filter (where c.relkind in ('v', 'm')) as views
, count(c.oid) filter (where c.relkind = 'S') as sequences
, (select count(*) from pg_catalog.pg_proc p where p.pronamespace = n.oid and p.prokind in ('f', 'p')) as routines
, ( select count(*)
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class tc on tc.oid = t.tgrelid
    where tc.relnamespace = n.oid
      and not t.tgisinternal
  ) as user_triggers
from pg_catalog.pg_namespace n
left join pg_catalog.pg_class c on c.relnamespace = n.oid
where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
  and n.nspname !~ '^pg_(temp|toast_temp)_'
group by n.oid, n.nspname
order by n.nspname
;
```

## Relations in one schema

`$1` = schema name. `reltuples` is a possibly stale estimate, not an exact row count; partitioned parents can show misleading sizes. `relispopulated` applies to materialized views. Privilege columns are current-role signals, not guarantees of access: schema usage, column grants, RLS, and underlying view objects may also matter.

```sql
select
  c.oid
, c.relname as object_name
, pg_catalog.pg_get_userbyid(c.relowner) as owner
, pg_catalog.has_schema_privilege(n.oid, 'USAGE') as current_role_has_schema_usage
, pg_catalog.has_table_privilege(c.oid, 'SELECT') as current_role_has_table_select
, case c.relkind
    when 'r' then 'table'
    when 'p' then 'partitioned table'
    when 'f' then 'foreign table'
    when 'v' then 'view'
    when 'm' then 'materialized view'
  end as kind
, c.reltuples::bigint as estimated_rows
, c.relrowsecurity as rls_enabled
, c.relispopulated as populated
, pg_catalog.obj_description(c.oid, 'pg_class') as comment
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 -- $1 = schema name
  and c.relkind in ('r', 'p', 'f', 'v', 'm')
order by c.relname
;
```

Use [tables](tables.md) for a local table, [foreign tables](foreign-tables.md) for `relkind = 'f'`, [views](views.md) for a view or materialized view, and [security](security.md) if RLS or visibility is relevant. Partition children may be listed as ordinary tables; inspect inheritance before counting them as independent business entities.

## Routines in one schema

`$1` = schema name. Signatures distinguish overloads; aggregates and window functions are omitted. Privilege columns reflect the current role, but do not guarantee a call will succeed. Inspect only relevant routines using [routines](routines.md).

```sql
select
  p.oid
, p.proname as routine_name
, pg_catalog.pg_get_userbyid(p.proowner) as owner
, pg_catalog.has_schema_privilege(n.oid, 'USAGE') as current_role_has_schema_usage
, pg_catalog.has_function_privilege(p.oid, 'EXECUTE') as current_role_has_execute
, case p.prokind when 'p' then 'procedure' else 'function' end as kind
, pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments
, pg_catalog.obj_description(p.oid, 'pg_proc') as comment
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = $1 -- $1 = schema name
  and p.prokind in ('f', 'p')
order by p.proname, identity_arguments
;
```

## User-defined triggers in one schema

`$1` = schema containing the relation on which the trigger is defined (the trigger function may be in another schema). Excludes internal triggers created by PostgreSQL, notably those enforcing foreign keys. Includes disabled triggers and trigger clones on partitions; `cloned_from_parent` identifies those clones. A trigger's existence does not establish that it currently fires. Drill into a relevant relation with [triggers](triggers.md) for definitions, events, and firing behavior.

```sql
select
  c.relname as relation_name
, t.tgname as trigger_name
, t.tgenabled as enabled_mode
, t.tgparentid <> 0 as cloned_from_parent
, fn.nspname as function_schema
, p.proname as function_name
, pg_catalog.pg_get_function_identity_arguments(p.oid) as function_identity_arguments
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_proc p on p.oid = t.tgfoid
join pg_catalog.pg_namespace fn on fn.oid = p.pronamespace
where n.nspname = $1
  and not t.tgisinternal
order by c.relname, t.tgname
;
```

Installed extensions often explain unfamiliar schemas and object names; see [extensions](extensions.md).

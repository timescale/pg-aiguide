# Triggers on a relation

Inspect triggers only on a relevant relation. `$1` = schema name; `$2` = relation name. PostgreSQL 18 target; fields used are also available in PostgreSQL 14–17.

```sql
select
  t.tgname as trigger_name
, t.tgisinternal as internal
, t.tgenabled as enabled_mode
, pg_catalog.pg_get_triggerdef(t.oid, true) as definition
, fn.nspname as function_schema
, p.proname as function_name
, pg_catalog.pg_get_function_identity_arguments(p.oid) as function_identity_arguments
, pg_catalog.obj_description(t.oid, 'pg_trigger') as comment
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_proc p on p.oid = t.tgfoid
join pg_catalog.pg_namespace fn on fn.oid = p.pronamespace
where n.nspname = $1
  and c.relname = $2
order by t.tgisinternal, t.tgname
;
```

`tgenabled`: `O` = origin/local mode, `R` = replica mode, `A` = always, `D` = disabled. `O` does not mean it always fires: session replication role matters. Internal triggers often implement FK constraints; do not mistake them for custom business logic. Use the definition to inspect event, timing, row/statement level, `WHEN`, transition tables, and column restrictions. Trigger naming order can affect execution when multiple triggers of the same kind fire; do not infer order from creation dates. Partitioned tables and their partitions can have cloned triggers: inspect the actual relation of interest. Read the target function using [routines](routines.md), never by causing a write. Definition and enabled state do not prove a trigger fired historically.

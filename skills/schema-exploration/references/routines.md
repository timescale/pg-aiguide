# Functions and procedures

Never execute a routine just to learn what it does. Start with a schema and name from [overview](overview.md). Overloads share a name: identify the correct signature before attributing behavior. Both queries use `$1` = schema name, `$2` = routine name. PostgreSQL 18 target; these catalog fields are present in PostgreSQL 14–17.

## Signatures, properties, and definitions

```sql
select
  p.oid
, p.proname as routine_name
, pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments
, pg_catalog.pg_get_function_arguments(p.oid) as declared_arguments
, pg_catalog.pg_get_function_result(p.oid) as result_type
, case p.prokind when 'p' then 'procedure' else 'function' end as kind
, l.lanname as language
, p.provolatile as volatility
, p.proparallel as parallel_safety
, p.prosecdef as security_definer
, p.proconfig as settings
, p.proacl as explicit_acl
, pg_catalog.has_function_privilege(p.oid, 'EXECUTE') as current_role_can_execute
, pg_catalog.obj_description(p.oid, 'pg_proc') as comment
, pg_catalog.pg_get_functiondef(p.oid) as definition
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
join pg_catalog.pg_language l on l.oid = p.prolang
where n.nspname = $1
  and p.proname = $2
  and p.prokind in ('f', 'p')
order by identity_arguments
;
```

`provolatile`: `i` immutable, `s` stable, `v` volatile; these are planner promises, not proof a routine is safe. `proconfig` contains per-routine settings (notably `search_path`); NULL inherits caller settings. `proacl = NULL` means default privileges, **not** no access. `SECURITY DEFINER` changes whose privileges apply; do not assume it is safe without checking source and search path. For non-SQL or restricted-language routines, definitions may not reveal the actual implementation. The current role may not be able to inspect every routine.

## Known dependents of a particular overload

`$1` = schema, `$2` = name, `$3` = identity argument string returned above. Dependent objects can include triggers, rewrite rules, defaults and SQL-standard-body routines.

```sql
select
  pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid) as dependent
, d.deptype as dependency_type
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
join pg_catalog.pg_depend d on d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
  and d.refobjid = p.oid
where n.nspname = $1
  and p.proname = $2
  and pg_catalog.pg_get_function_identity_arguments(p.oid) = $3
order by d.classid, d.objid, d.objsubid
;
```

Catalog dependencies are incomplete for PL/pgSQL bodies and dynamic SQL. No dependents does not mean unused: application code may call a function directly. For trigger callers, continue with [triggers](triggers.md). For view callers, continue with [views](views.md). Interpret extension-owned routines in context of [extensions](extensions.md).

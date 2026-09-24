# Views and materialized views

Use a specific view found in [overview](overview.md). For both queries `$1` = schema name and `$2` = view name. PostgreSQL 18 is the target; the catalog fields used here also exist in PostgreSQL 14–17.

## Definition and behavior

```sql
select
  c.oid
, c.relkind
, c.relispopulated as materialized_view_populated
, c.reloptions
, pg_catalog.pg_get_viewdef(c.oid, true) as query_definition
, pg_catalog.obj_description(c.oid, 'pg_class') as comment
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1
  and c.relname = $2
  and c.relkind in ('v', 'm')
;
```

`relkind = 'm'` means a materialized view; `relispopulated = false` means it cannot be scanned until refreshed. The catalog does not tell you when or how often it is refreshed. `reloptions` may include `security_barrier` or `security_invoker` on ordinary views; absent `security_invoker`, access to underlying relations is generally checked as the view owner, subject to PostgreSQL's view/RLS rules. Read [security](security.md) before drawing access conclusions. View definitions can contain calls to user functions: **read, do not execute them**.

## Direct relation dependencies

Catalog dependencies are recorded on the view's rewrite rule. The query excludes the self-dependency and deduplicates column-level references. It does not expose dynamic SQL or identify every routine call in procedural bodies.

```sql
select distinct
  dn.nspname as referenced_schema
, dep.relname as referenced_relation
, dep.relkind as referenced_kind
from pg_catalog.pg_class v
join pg_catalog.pg_namespace vn on vn.oid = v.relnamespace
join pg_catalog.pg_rewrite r on r.ev_class = v.oid
join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
  and d.objid = r.oid
  and d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
join pg_catalog.pg_class dep on dep.oid = d.refobjid and dep.oid <> v.oid
join pg_catalog.pg_namespace dn on dn.oid = dep.relnamespace
where vn.nspname = $1
  and v.relname = $2
  and v.relkind in ('v', 'm')
order by dn.nspname, dep.relname
;
```

A view can depend on another view; follow the chain only as far as the question requires. A view's joins and predicates show an intended interpretation, but do not prove data invariants on its source tables. Extensions may define continuous aggregates or other materialized-view-like objects with their own maintenance semantics; see [extensions](extensions.md).

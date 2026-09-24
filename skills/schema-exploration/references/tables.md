# Tables: grain, constraints, and relationships

## Contents

- [Size and object signals](#size-and-object-signals)
- [Columns](#columns)
- [Constraints](#constraints)
- [Foreign keys touching the table](#foreign-keys-touching-the-table)
- [Views directly depending on this table](#views-directly-depending-on-this-table)
- [Indexes](#indexes)
- [Partitioning and inheritance](#partitioning-and-inheritance)
- [Interpret and stop](#interpret-and-stop)

Use the schema and relation name from [overview](overview.md). In every query `$1` = schema name, `$2` = table name. Names are filtered as values, not interpolated as identifiers. These queries target PostgreSQL 18; see the constraint note for earlier majors.

## Size and object signals

These are approximate planning statistics, not a count of visible rows. A partitioned parent's own size excludes children; foreign-table size is not meaningful (see [foreign tables](foreign-tables.md)). Do not use this as a reason to scan data. The four structural flags are independent: a partition can also be a partitioned parent. Declarative partitions and traditional inheritance both use `pg_inherits`; `relispartition` distinguishes their edges. `has_user_triggers` excludes PostgreSQL's internal triggers, notably the ones created for foreign keys; those relationships are already covered under constraints. The flag includes disabled user-defined triggers. If relevant, drill down with [triggers](triggers.md) to inspect enabled state and behavior.

```sql
select
  c.reltuples::bigint as estimated_rows
, c.relpages as estimated_pages
, pg_catalog.pg_total_relation_size(c.oid) as total_bytes
, c.relkind = 'p' as is_partitioned_parent
, c.relispartition as is_partition
, exists (
    select 1
    from pg_catalog.pg_inherits i
    join pg_catalog.pg_class child on child.oid = i.inhrelid
    where i.inhparent = c.oid
      and not child.relispartition
  ) as has_inheritance_children
, not c.relispartition and exists (
    select 1
    from pg_catalog.pg_inherits i
    where i.inhrelid = c.oid
  ) as has_inheritance_parent
, exists (
    select 1
    from pg_catalog.pg_trigger t
    where t.tgrelid = c.oid
      and not t.tgisinternal
  ) as has_user_triggers
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1
  and c.relname = $2
  and c.relkind in ('r', 'p', 'f')
;
```

## Columns

```sql
select
  a.attnum as position
, a.attname as column_name
, pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type
, a.attnotnull as not_null
, pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_or_generation_expression
, a.attidentity as identity_kind
, a.attgenerated as generated_kind
, pg_catalog.col_description(a.attrelid, a.attnum) as comment
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_attribute a on a.attrelid = c.oid
left join pg_catalog.pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
where n.nspname = $1
  and c.relname = $2
  and c.relkind in ('r', 'p', 'f')
  and a.attnum > 0
  and not a.attisdropped
order by a.attnum
;
```

`attidentity`: `a` = always, `d` = by default, blank = neither. `attgenerated`: `s` = stored; PostgreSQL 18 adds `v` = virtual. On PostgreSQL 14–17 only stored generated columns exist; the same query runs there.

## Constraints

Use definitions, not constraint names, to interpret keys and checks. PostgreSQL 18 can represent NOT NULL in `pg_constraint` (`contype = 'n'`); on earlier versions rely on `pg_attribute.attnotnull` above. Domain constraints and constraints on partition parents may also matter.

```sql
select
  con.conname as constraint_name
, con.contype as kind
, con.convalidated as validated
, pg_catalog.pg_get_constraintdef(con.oid, true) as definition
, pg_catalog.obj_description(con.oid, 'pg_constraint') as comment
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_constraint con on con.conrelid = c.oid
where n.nspname = $1
  and c.relname = $2
  and c.relkind in ('r', 'p', 'f')
order by con.contype, con.conname
;
```

`contype`: `p` primary key, `u` unique, `f` foreign key, `c` check, `x` exclusion, `n` NOT NULL (PG18). A unique index is not necessarily a unique constraint. A valid FK shows an enforced relationship, not necessarily the only relationship used by the application.

## Foreign keys touching the table

Includes outgoing and incoming keys, with ordered column pairs (including composite keys). `$1` and `$2` still identify the chosen table. Use schema-qualified names in findings.

```sql
select
  sn.nspname as from_schema
, src.relname as from_table
, con.conname as constraint_name
, pg_catalog.pg_get_constraintdef(con.oid, true) as definition
, tn.nspname as to_schema
, dst.relname as to_table
, con.convalidated as validated
from pg_catalog.pg_constraint con
join pg_catalog.pg_class src on src.oid = con.conrelid
join pg_catalog.pg_namespace sn on sn.oid = src.relnamespace
join pg_catalog.pg_class dst on dst.oid = con.confrelid
join pg_catalog.pg_namespace tn on tn.oid = dst.relnamespace
where con.contype = 'f'
  and ((sn.nspname = $1 and src.relname = $2)
    or (tn.nspname = $1 and dst.relname = $2))
order by sn.nspname, src.relname, con.conname
;
```

## Views directly depending on this table

Run this only if you need to know how the table is exposed or transformed. `$1` and `$2` identify the table. PostgreSQL records a view's relation dependencies on its `_RETURN` rewrite rule; `distinct` collapses multiple column-level dependencies to the same table. The result includes ordinary and materialized views across schemas, but **only direct dependencies**. To follow a view-on-view chain, inspect each result using [views](views.md). Application queries, procedural bodies, and dynamic SQL are not covered; a partition's parent may be the object referenced by a view rather than that individual partition.

```sql
select distinct
  vn.nspname as view_schema
, v.relname as view_name
, case v.relkind when 'm' then 'materialized view' else 'view' end as view_kind
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_depend d on d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
  and d.refobjid = c.oid
  and d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
join pg_catalog.pg_rewrite r on r.oid = d.objid and r.rulename = '_RETURN'
join pg_catalog.pg_class v on v.oid = r.ev_class and v.relkind in ('v', 'm')
join pg_catalog.pg_namespace vn on vn.oid = v.relnamespace
where n.nspname = $1
  and c.relname = $2
  and c.relkind in ('r', 'p', 'f')
  and v.oid <> c.oid
order by vn.nspname, v.relname
;
```

## Indexes

```sql
select
  i.relname as index_name
, pg_catalog.pg_get_indexdef(i.oid) as definition
, ix.indisunique as unique_index
, ix.indisvalid as valid
, ix.indisready as ready
, pg_catalog.pg_relation_size(i.oid) as bytes
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_index ix on ix.indrelid = c.oid
join pg_catalog.pg_class i on i.oid = ix.indexrelid
where n.nspname = $1
  and c.relname = $2
order by i.relname
;
```

## Partitioning and inheritance

If any of the four structural flags above is true, use [partitioning and inheritance](partitioning-and-inheritance.md) to traverse the relevant tree. Do not enumerate every partition just to understand an unrelated table.

## Interpret and stop

Infer grain from keys, uniqueness, and columns; confirm it with the user when unclear. A matching `*_id` name does not prove a join. Indexes suggest access paths, not usage; row estimates can be stale. If you need typical values or distributions, follow [data-derived values](data-values.md) and obtain approval before querying statistics **or** rows. Never run an unbounded `select *` or a full `count(*)` just to orient yourself.

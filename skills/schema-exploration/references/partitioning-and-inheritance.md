# Partitioning and inheritance: traverse a table's tree

Use the four structural flags in [tables](tables.md#size-and-object-signals) to choose a traversal. Each query uses `$1` = schema name, `$2` = relation name and returns **the selected relation at depth 0** plus its ancestors or descendants. A query for the wrong kind of relation returns no rows. Names are always schema-qualified in the result. Depth is the number of parent–child edges from the selected relation; a subpartition can be both a partition and a partitioned parent. Queries target PostgreSQL 18 and also run on PostgreSQL 14–17.

## Contents

- [Partition ancestors (up)](#partition-ancestors-up)
- [Partition descendants (down)](#partition-descendants-down)
- [Traditional inheritance ancestors (up)](#traditional-inheritance-ancestors-up)
- [Traditional inheritance descendants (down)](#traditional-inheritance-descendants-down)

## Partition ancestors (up)

Run when `is_partition` is true. Each ancestor row identifies the child through which it was reached. The selected partition's bounds and each ancestor's partition key are shown. `pg_inherits` edges are followed only when the child is a declarative partition.

```sql
with recursive walk as (
  select
    c.oid as relid
  , null::oid as via_child_oid
  , 0 as depth
  , array[c.oid] as path
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1
    and c.relname = $2
    and c.relispartition
  union all
  select
    parent.oid
  , child.oid
  , w.depth + 1
  , w.path || parent.oid
  from walk w
  join pg_catalog.pg_class child on child.oid = w.relid and child.relispartition
  join pg_catalog.pg_inherits i on i.inhrelid = child.oid
  join pg_catalog.pg_class parent on parent.oid = i.inhparent
  where not parent.oid = any(w.path)
)
select
  w.depth
, n.nspname as schema_name
, c.relname as relation_name
, cn.nspname as via_child_schema
, child.relname as via_child_name
, pg_catalog.pg_get_partkeydef(c.oid) as partition_key
, pg_catalog.pg_get_expr(c.relpartbound, c.oid) as partition_bounds
from walk w
join pg_catalog.pg_class c on c.oid = w.relid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_class child on child.oid = w.via_child_oid
left join pg_catalog.pg_namespace cn on cn.oid = child.relnamespace
order by w.depth
;
```

## Partition descendants (down)

Run when `is_partitioned_parent` is true. PostgreSQL's `pg_partition_tree()` already walks the declarative partition tree, so no custom recursive CTE is needed here. Each result row identifies its **direct parent**, whether it is a leaf, and its partition bounds. The root has no parent and depth (`level`) 0. This function has been available since PostgreSQL 12.

```sql
with root as materialized (
  select c.oid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1
    and c.relname = $2
    and c.relkind = 'p'
)
select
  t.level as depth
, n.nspname as schema_name
, c.relname as relation_name
, pn.nspname as parent_schema
, parent.relname as parent_name
, t.isleaf as is_leaf
, pg_catalog.pg_get_partkeydef(c.oid) as partition_key
, pg_catalog.pg_get_expr(c.relpartbound, c.oid) as partition_bounds
from root
cross join lateral pg_catalog.pg_partition_tree(root.oid) t
join pg_catalog.pg_class c on c.oid = t.relid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_class parent on parent.oid = t.parentrelid
left join pg_catalog.pg_namespace pn on pn.oid = parent.relnamespace
order by t.level, n.nspname, c.relname
;
```

## Traditional inheritance ancestors (up)

Run when `has_inheritance_parent` is true. Follow only edges whose child is **not** a declarative partition. Each ancestor row identifies the child through which it was reached. Multiple inheritance can produce more than one path to a relation; paths are not collapsed.

```sql
with recursive walk as (
  select
    c.oid as relid
  , null::oid as via_child_oid
  , 0 as depth
  , array[c.oid] as path
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1
    and c.relname = $2
    and not c.relispartition
    and exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid)
  union all
  select
    parent.oid
  , child.oid
  , w.depth + 1
  , w.path || parent.oid
  from walk w
  join pg_catalog.pg_class child on child.oid = w.relid and not child.relispartition
  join pg_catalog.pg_inherits i on i.inhrelid = child.oid
  join pg_catalog.pg_class parent on parent.oid = i.inhparent
  where not parent.oid = any(w.path)
)
select
  w.depth
, n.nspname as schema_name
, c.relname as relation_name
, cn.nspname as via_child_schema
, child.relname as via_child_name
from walk w
join pg_catalog.pg_class c on c.oid = w.relid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_class child on child.oid = w.via_child_oid
left join pg_catalog.pg_namespace cn on cn.oid = child.relnamespace
order by w.depth, n.nspname, c.relname
;
```

## Traditional inheritance descendants (down)

Run when `has_inheritance_children` is true. Each descendant row names its direct parent; the starting relation has no parent in this traversal. Multiple inheritance can yield more than one path to a descendant.

```sql
with recursive walk as (
  select
    c.oid as relid
  , null::oid as parent_oid
  , 0 as depth
  , array[c.oid] as path
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1
    and c.relname = $2
    and exists (
      select 1
      from pg_catalog.pg_inherits i
      join pg_catalog.pg_class child on child.oid = i.inhrelid
      where i.inhparent = c.oid
        and not child.relispartition
    )
  union all
  select
    child.oid
  , w.relid
  , w.depth + 1
  , w.path || child.oid
  from walk w
  join pg_catalog.pg_inherits i on i.inhparent = w.relid
  join pg_catalog.pg_class child on child.oid = i.inhrelid and not child.relispartition
  where not child.oid = any(w.path)
)
select
  w.depth
, n.nspname as schema_name
, c.relname as relation_name
, pn.nspname as parent_schema
, parent.relname as parent_name
from walk w
join pg_catalog.pg_class c on c.oid = w.relid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_class parent on parent.oid = w.parent_oid
left join pg_catalog.pg_namespace pn on pn.oid = parent.relnamespace
order by w.depth, n.nspname, c.relname
;
```

These trees describe catalog structure, not whether a query scans every child or where every row is stored. Ordinary inheritance and declarative partitioning have different query and constraint semantics. TimescaleDB hypertables require extension-specific interpretation; see [extensions](extensions.md).

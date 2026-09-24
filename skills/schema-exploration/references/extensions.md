# Installed extensions and extension-owned objects

Use this reference if an unfamiliar schema or object appears to come from an extension. PostgreSQL 18 target; queries also use fields available in PostgreSQL 14–17. An installed extension is a clue, not evidence that its features are used by the application.

## Installed extensions

No parameters.

```sql
select
  e.extname as extension_name
, e.extversion as installed_version
, n.nspname as installation_schema
, pg_catalog.obj_description(e.oid, 'pg_extension') as comment
from pg_catalog.pg_extension e
join pg_catalog.pg_namespace n on n.oid = e.extnamespace
order by e.extname
;
```

## Objects belonging to an extension

`$1` = extension name. Membership uses `pg_depend.deptype = 'e'`; merely residing in the extension's schema does not prove ownership. Object identity can disclose source names: keep output scoped.

```sql
select
  o.type as object_type
, o.schema as object_schema
, o.identity as object_identity
from pg_catalog.pg_extension e
join pg_catalog.pg_depend d on d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
  and d.refobjid = e.oid
  and d.deptype = 'e'
cross join lateral pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid) o
where e.extname = $1 -- $1 = extension name
order by o.type, o.schema, o.identity
;
```

The owner of an extension can create application objects in the same schema, and application objects can depend on extension types or functions without being extension members. Conversely, extension-owned objects can live outside the extension's installation schema. Extension versions and feature availability are distinct from PostgreSQL server versions. For TimescaleDB, PostGIS, or pgvector, follow their documentation when interpreting extension-specific constructs; do not infer their internal representation from generic relation counts alone.

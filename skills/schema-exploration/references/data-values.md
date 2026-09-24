# Data-derived values (opt in)

Use this reference only when types, constraints, defaults, enum labels, comments, and view definitions cannot answer the user's question. **Ask for approval before reading either statistics or table rows.** Name the schema, table, columns, purpose, and whether you propose catalog statistics or row sampling. Approval for that scope can cover a small sequence of bounded queries; do not silently expand to other columns or tables. If approval is declined, explain what cannot be determined from schema alone.

Constraints and enum labels describe **permitted** values. Statistics and row samples describe values **observed** at some point; neither establishes the complete set of valid values. Both can disclose sensitive data. Use a role authorized for the investigation, honor RLS and privilege boundaries, and do not log or export raw values unnecessarily.

Queries target PostgreSQL 18; the `pg_stats` columns and `TABLESAMPLE SYSTEM` syntax below are also available in PostgreSQL 14–17. `$1` = schema name, `$2` = table name, `$3` = a `text[]` of approved column names (for example, `ARRAY['status']::text[]`).

## 1. Read existing column statistics

After approval, start with `pg_catalog.pg_stats`, the supported view over planner statistics; do not query raw `pg_statistic`. Restrict it to the approved columns. This query reads stored statistics rather than scanning the table, but the most-common values and histogram bounds may contain real data values.

```sql
select
  s.attname as column_name
, s.inherited
, s.null_frac
, s.n_distinct
, s.most_common_vals::text as most_common_vals
, s.most_common_freqs
, s.histogram_bounds::text as histogram_bounds
from pg_catalog.pg_stats s
where s.schemaname = $1
  and s.tablename = $2
  and s.attname = any($3::text[])
order by s.attname, s.inherited
;
```

`inherited = true` describes statistics including inheritance children when available; the two rows may differ. `null_frac` is estimated. Positive `n_distinct` estimates the count of distinct values; negative values estimate the distinct fraction relative to row count (`-1` means roughly all values differ). Most-common values and histogram bounds are samples used by the planner, not an exhaustive vocabulary or exact range. Statistics can be stale, missing (no `ANALYZE` yet), suppressed by privileges, or unrepresentative of the rows visible under RLS. Do not run `ANALYZE` yourself to fill gaps.

## 2. Optionally sample rows

Only if approved statistics are insufficient, ask for **row-sampling approval** if it was not already granted. Check the table's estimated size in [tables](tables.md) first and keep a statement timeout; a sampling percentage and `LIMIT` are **not** a fixed work budget. `SYSTEM` samples physical pages, so it can miss rare values, favor clustered values, or return no rows on small tables. `BERNOULLI` samples rows but typically reads the whole relation. Do not retry with a larger percentage or run a full-table distribution query without further approval.

`SYSTEM (0.01)` means **0.01% of pages (one-hundredth of one percent)**, not 1%. With roughly uniform rows per page, an estimate of rows in the sample *before* `LIMIT` is `pg_class.reltuples × 0.0001` (or `reltuples / 10,000`). For the table being considered, `$1` = schema name and `$2` = table name:

```sql
select
  c.reltuples::bigint as estimated_table_rows
, case when c.reltuples >= 0 then round(c.reltuples::numeric / 10000)::bigint end as estimated_sample_rows_before_limit
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1
  and c.relname = $2
  and c.relkind = 'r'
;
```

This is an **expectation**, not a minimum or maximum: `reltuples` may be stale or `-1` (unknown), physical page densities vary, and random sampling can return zero rows. `LIMIT 10` caps *returned* rows, not pages examined or the work required.

Identifiers cannot be bound as `$1` in `FROM` or in a column list. The following **parameterized generator** verifies the approved column names and produces a complete SQL statement with safely quoted identifiers. It only targets ordinary tables or individual partition children (`relkind = 'r'`); it does not sample foreign tables, views, or partitioned parents. At most five named columns are allowed. Run the generated statement separately, after reviewing its table and column list. No output means the table or one of the requested columns was not found (or the column list has duplicates); do not fall back to raw interpolation.

```sql
select
  pg_catalog.format(
    'select %s from %I.%I tablesample system (0.01) limit 10;'
  , pg_catalog.string_agg(pg_catalog.format('%I', a.attname), ', ' order by wanted.ord)
  , n.nspname
  , c.relname
  ) as sample_sql
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
cross join lateral unnest($3::text[]) with ordinality wanted(column_name, ord)
join pg_catalog.pg_attribute a on a.attrelid = c.oid
  and a.attname = wanted.column_name
  and a.attnum > 0
  and not a.attisdropped
where n.nspname = $1
  and c.relname = $2
  and c.relkind = 'r'
  and pg_catalog.cardinality($3::text[]) between 1 and 5
group by c.oid, n.nspname, c.relname
having count(*) = pg_catalog.cardinality($3::text[])
  and count(distinct a.attnum) = pg_catalog.cardinality($3::text[])
;
```

The generated query selects only the approved columns, samples about 0.01% of pages (one-hundredth of one percent), and returns at most 10 rows. It may still read more than 10 rows' worth of pages, and the sample may be empty. Sampling actual rows can reveal identifiers or personal information even if the columns sound harmless. If only aggregate distributions are needed, agree on an appropriate cost and privacy budget before running any `GROUP BY` or `count(*)`; those can scan the entire table.

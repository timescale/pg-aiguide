# Privileges, views, and row-level security

Catalog rows alone do not prove what a role can query or which rows it will see. Scope all queries to the relation under investigation. `$1` = schema name; `$2` = relation name. PostgreSQL 18 target; these fields and functions also exist in PostgreSQL 14–17.

## Relation state and current-role privileges

```sql
select
  c.relkind
, c.relrowsecurity as rls_enabled
, c.relforcerowsecurity as force_rls_for_owner
, c.relowner::pg_catalog.regrole as owner
, c.reloptions
, pg_catalog.has_schema_privilege(n.oid, 'USAGE') as schema_usage
, pg_catalog.has_table_privilege(c.oid, 'SELECT') as current_role_can_select
, pg_catalog.row_security_active(c.oid) as rls_active_for_current_role
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1
  and c.relname = $2
  and c.relkind in ('r', 'p', 'f', 'v', 'm')
;
```

`row_security_active` evaluates the current role and context; an owner normally bypasses RLS unless forced, while superusers and roles with `BYPASSRLS` bypass it. View access depends on view ownership and `security_invoker` (where specified in `reloptions`), not simply on the calling role's table access. Column grants, inherited roles, and function permissions may matter too. `SELECT` privilege does not imply seeing every row.

## Policies on the relation

```sql
select
  pol.polname as policy_name
, pol.polcmd as command
, pol.polpermissive as permissive
, array(
    select case when role_oid = 0 then 'PUBLIC' else role_oid::pg_catalog.regrole::text end
    from unnest(pol.polroles) role_oid
  ) as roles
, pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) as using_expression
, pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check_expression
from pg_catalog.pg_policy pol
join pg_catalog.pg_class c on c.oid = pol.polrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1
  and c.relname = $2
order by pol.polname
;
```

`polcmd`: `*` all, `r` SELECT, `a` INSERT, `w` UPDATE, `d` DELETE. Policy roles can apply through membership, not only an exact role name. Permissive policies combine with OR, restrictive with AND; absence of applicable policies under enabled RLS defaults to deny. A policy's presence does not imply RLS is enabled or active for this role. Reading a policy expression is not equivalent to evaluating it; it may call other functions. Do not switch roles, bypass RLS, or query protected rows to test a hypothesis without explicit authorization.

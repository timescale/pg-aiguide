/**
 * Matches a PostgreSQL identifier that is safe to interpolate unquoted:
 * starts with a lowercase letter or underscore, followed by lowercase letters,
 * digits, underscores, or dollar signs, up to 63 characters (NAMEDATALEN - 1).
 */
const UNQUOTED_IDENTIFIER = /^[a-z_][a-z0-9_$]{0,62}$/;

export const DEFAULT_DB_SCHEMA = 'docs';

/**
 * Resolve and validate the database schema name.
 *
 * The schema name is operator-supplied configuration that gets interpolated
 * into SQL in several different syntactic positions (bare identifiers, inside
 * single-quoted index names passed to `to_bm25query`, and the `search_path`
 * connection option). Rather than escaping differently at each of those call
 * sites, we validate once here and guarantee the value is a plain unquoted
 * identifier, which is valid in all of them.
 */
export const parseDbSchema = (value: string | undefined): string => {
  const dbSchema = value?.trim() || DEFAULT_DB_SCHEMA;
  if (!UNQUOTED_IDENTIFIER.test(dbSchema)) {
    throw new Error(
      `Invalid DB_SCHEMA "${dbSchema}": must be an unquoted PostgreSQL identifier ` +
        `matching ${UNQUOTED_IDENTIFIER.source} (lowercase letters, digits, underscores, and dollar signs).`,
    );
  }
  return dbSchema;
};

export const schema = parseDbSchema(process.env.DB_SCHEMA);

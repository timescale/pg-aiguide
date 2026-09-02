# Tiger Docs MCP Server - Development Guidelines

## Build, Test & Run Commands

- Build: `./bun run build` - Compiles TypeScript to JavaScript
- Watch mode: `./bun run watch http` - Watches for changes and rebuilds automatically
- Run server: `./bun run start stdio` - Starts the MCP server using stdio transport
- Checks: `./check` - All-in-one command to lint and test. Run before every commit.
  Covers TypeScript (biome, tsc, tests) and Python (`ruff format` + `ruff check`
  in `ingest/`). Python checks are skipped with a warning if `uv` is missing.

## Code Style Guidelines

- Use ES modules with `.js` extension in import paths
- Strictly type all functions and variables with TypeScript
- Follow zod schema patterns for tool input validation
- Use `.nullable()` instead of `.optional()` for optional MCP tool parameters (required for gpt-5 compatibility)
- Prefer async/await over callbacks and Promise chains
- Place all imports at top of file, grouped by external then internal
- Use descriptive variable names that clearly indicate purpose
- Implement proper cleanup for timers and resources in server shutdown
- Follow camelCase for variables/functions, PascalCase for types/classes, UPPER_CASE for constants
- Handle errors with try/catch blocks and provide clear error messages
- Use consistent indentation (2 spaces) and trailing commas in multi-line objects

### Python (`ingest/`)

- Formatted and linted by `ruff`; config lives in `ingest/pyproject.toml`
- Never commit generated artifacts (`__pycache__/`, `*.pyc`, `.venv/`, `.ruff_cache/`)
- Add dev-only tooling to the `dev` dependency group, not `dependencies`
- Commit the regenerated `uv.lock` whenever dependencies change; CI runs `uv lock --check`
- Chain re-raised exceptions with `raise ... from e` to preserve the original traceback

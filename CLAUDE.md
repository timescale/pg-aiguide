# Tiger Docs MCP Server - Development Guidelines

## Build, Test & Run Commands

- Build: `./bun run build` - Compiles TypeScript to JavaScript
- Watch mode: `./bun run watch http` - Watches for changes and rebuilds automatically
- Run server: `./bun run start stdio` - Starts the MCP server using stdio transport

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

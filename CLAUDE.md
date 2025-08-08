# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Core Commands

### Development
- `pnpm run build` - Compile TypeScript to JavaScript in dist/ directory
- `pnpm start` - Run the compiled MCP server
- `pnpm install` - Install dependencies

### MCP Server Installation
- `pnpm run install-server` - Install to all MCP clients (Claude Desktop, Cursor, Claude Code, Gemini, MCP)
- `pnpm run install-desktop` - Install to Claude Desktop only
- `pnpm run install-cursor` - Install to Cursor only  
- `pnpm run install-code` - Install to Claude Code only
- `pnpm run install-mcp` - Install to .mcp.json only

Installation scripts automatically build the project and update the respective configuration files.

## Architecture

This is an MCP (Model Context Protocol) server for TypeScript static analysis built with:

- **Core Framework**: @modelcontextprotocol/sdk for MCP server implementation
- **Analysis Engine**: ts-morph for TypeScript AST analysis and manipulation
- **Runtime**: Node.js with ES modules (`"type": "module"`)
- **Language**: TypeScript with ES2022 target
- **Schema Validation**: Zod for parameter validation
- **Transport**: StdioServerTransport for communication
- **Caching**: LRU cache and node-persist for performance optimization

### Project Structure
```
src/
├── index.ts           # Main MCP server implementation
├── tools.ts           # Tool definitions and handlers
├── analyzer.ts        # TypeScript analysis engine
├── cache.ts           # Caching layer implementation
├── types.ts           # Type definitions
├── utils.ts           # Utility functions
scripts/
├── update-config.js   # Multi-client configuration installer
dist/                  # Compiled JavaScript output
```

### Server Implementation Pattern

The server follows this pattern in src/index.ts:

1. **Server Creation**: `McpServer` instance with name and version
2. **Tool Registration**: Using `server.tool()` with Zod schema validation
3. **Transport Setup**: StdioServerTransport for client communication
4. **Error Handling**: Comprehensive error handling with process.exit(1)

### Tool Definition Pattern

Tools are defined with:
- Tool name (string)
- Description (string)  
- Parameters schema (Zod object)
- Async handler function returning `{ content: [{ type: "text", text: string }] }`

### Configuration Management

The `scripts/update-config.js` handles:
- Multi-client configuration (Claude Desktop, Cursor, Claude Code, Gemini, MCP)
- Environment variable parsing from .env.local
- Automatic directory creation for config files
- Command-line argument parsing for selective installation
- Local .mcp.json file creation for project-specific MCP configuration

### Key Dependencies

- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `ts-morph` - TypeScript compiler API wrapper for AST analysis
- `zod` - Runtime type validation for tool parameters
- `lru-cache` - In-memory LRU caching for performance
- `node-persist` - Persistent storage for analysis results
- `glob` - File pattern matching
- `minimatch` - File filtering

## Environment Variables

Optional `.env.local` file for environment variables that get automatically included in MCP server configuration.

## Development Workflow

1. Modify `src/*.ts` files to add/update tools or analysis functionality
2. Run `pnpm run build` to compile
3. Test with `pnpm start`
4. Use installation scripts to update MCP client configurations
5. Restart MCP clients to load changes

## Static Analysis Features

This MCP server provides TypeScript static analysis capabilities including:

- Compilation error detection and reporting
- AST-based code analysis
- File structure analysis
- Import/export dependency tracking
- Type checking and inference
- Code quality metrics
- Performance-optimized caching
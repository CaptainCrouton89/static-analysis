# MCP TypeScript Analyzer

A Model Context Protocol (MCP) server for TypeScript static code analysis using ts-morph. This tool provides deep code analysis capabilities for understanding TypeScript codebases.

## Features

- **File Analysis**: Extract symbols, imports, and exports from TypeScript files
- **Symbol Analysis**: Get detailed information about functions, classes, interfaces, and types
- **Reference Finding**: Track all usages of a symbol across your codebase
- **Compilation Errors**: Get TypeScript compilation diagnostics without building

## Installation

1. **Build the server**:

   ```bash
   npm run build
   ```

2. **Install to MCP clients**:

   ```bash
   # Install to all supported clients
   npm run install-server

   # Install to specific clients
   npm run install-cursor    # Cursor IDE
   npm run install-desktop   # Claude Desktop
   npm run install-code      # Claude Code CLI
   ```

## Available Tools

### 1. `analyze_file`

Quickly analyze a TypeScript file to extract all symbols, imports, and exports.

**Parameters:**

- `filePath` (string, required): Path to the TypeScript file
- `analysisType` (enum): "symbols", "dependencies", or "all" (default: "all")
- `includeDefinition` (boolean): Include symbol definition locations (default: false)

### 2. `analyze_symbol`

Get detailed analysis of a specific symbol including parameters, return types, and members.

**Parameters:**

- `symbolIdentifier` (object, required):
  - `filePath` (string): Path to the file
  - `symbolName` (string): Name of the symbol
  - `line` (number): Line number where symbol appears (1-based)
- `maxTypeLength` (number): Maximum type string length (default: unlimited)

### 3. `find_references`

Find all references to a symbol across the codebase for understanding usage patterns.

**Parameters:**

- `symbolIdentifier` (object, required):
  - `filePath` (string): Path to the file
  - `symbolName` (string): Name of the symbol
  - `line` (number): Line number where symbol appears (1-based)
- `maxResults` (number): Maximum references to return (default: 100)

### 4. `get_compilation_errors`

Get TypeScript compilation errors without building the project.

**Parameters:**

- `path` (string, required): File or directory path to analyze
- `includeWarnings` (boolean): Include warnings (default: true)
- `includeInfo` (boolean): Include info messages (default: false)
- `filePattern` (string): Glob pattern for files (default: "**/*.{ts,tsx}")
- `maxFiles` (number): Maximum files to analyze (default: 25)
- `verbosity` (enum): "minimal", "normal", or "detailed" (default: "normal")

## Performance Features

- **Intelligent Caching**: Automatically caches parsed files for faster analysis
- **Parallel Processing**: Handles multiple files concurrently
- **Memory Management**: Built-in memory monitoring to prevent crashes
- **Error Recovery**: Graceful handling of TypeScript errors and invalid files

## Configuration

The server automatically detects and uses your project's `tsconfig.json` file for accurate type analysis. No additional configuration is required.

## Usage Examples

### Analyze a TypeScript file

```typescript
// Analyze src/index.ts
await mcp.analyze_file({
  filePath: "./src/index.ts",
  analysisType: "all"
})
```

### Get detailed symbol information

```typescript
// Get details about a UserService class on line 25
await mcp.analyze_symbol({
  symbolIdentifier: {
    filePath: "./src/services/user.ts",
    symbolName: "UserService",
    line: 25
  }
})
```

### Find all references to a symbol

```typescript
// Find where getUserById is used
await mcp.find_references({
  symbolIdentifier: {
    filePath: "./src/api/users.ts",
    symbolName: "getUserById",
    line: 42
  }
})
```

### Check for TypeScript errors

```typescript
// Check entire src directory for errors
await mcp.get_compilation_errors({
  path: "./src",
  verbosity: "normal"
})
```

## Requirements

- Node.js 18+
- TypeScript project with `tsconfig.json`

## License

MIT

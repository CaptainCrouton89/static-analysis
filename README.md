# MCP TypeScript Analyzer

A Model Context Protocol (MCP) server for comprehensive TypeScript code analysis using ts-morph. This server provides advanced static analysis capabilities for TypeScript codebases, including symbol extraction, dependency analysis, code quality detection, and pattern matching.

## Features

- **File Analysis**: Comprehensive analysis of TypeScript files with configurable depth and detail
- **Symbol Search**: Semantic symbol search across codebases with scoring and filtering
- **Pattern Matching**: AST-based, semantic, and regex pattern detection
- **Code Quality**: Automated detection of code smells and complexity issues
- **Reference Tracking**: Find all references to symbols with context
- **Dependency Analysis**: Import/export dependency graph generation
- **Context Extraction**: AI-friendly context extraction for code understanding
- **Codebase Summarization**: High-level architectural analysis and metrics

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

Analyzes a single TypeScript file with configurable depth and detail.

**Parameters:**

- `filePath` (string): Path to the TypeScript file
- `analysisType` (enum): Type of analysis - "symbols", "dependencies", "complexity", "all"
- `depth` (number): Analysis depth (1-3, default: 2)
- `includePrivate` (boolean): Include private members (default: false)
- `outputFormat` (enum): Output format - "summary", "detailed", "full" (default: "summary")

### 2. `search_symbols`

Search for symbols across the codebase using various strategies.

**Parameters:**

- `query` (string): Search query
- `searchType` (enum): Search type - "text", "semantic", "ast-pattern"
- `symbolTypes` (array): Filter by symbol types (class, interface, function, etc.)
- `maxResults` (number): Maximum results to return (default: 50)
- `includeReferences` (boolean): Include reference information (default: false)

### 3. `get_symbol_info`

Get detailed information about a specific symbol at a given position.

**Parameters:**

- `filePath` (string): Path to the file
- `position` (object): Line and character position
- `includeRelationships` (boolean): Include type relationships (default: true)
- `includeUsages` (boolean): Include usage information (default: false)
- `depth` (number): Analysis depth (default: 2)

## Advanced Features

### Caching System

The server includes an intelligent caching system that:

- Caches parsed TypeScript files and analysis results
- Adapts caching strategy based on project size
- Provides significant performance improvements for repeated operations

### Performance Optimization

- Parallel processing for multi-file operations
- Configurable timeouts and memory monitoring
- Adaptive algorithms based on codebase size

### Error Handling

- Comprehensive error reporting with detailed context
- Graceful degradation for partially corrupt files
- Structured error codes for programmatic handling

## Configuration

### Environment Variables

Create a `.env.local` file to configure the server:

```env
# Optional: Set custom timeout values
ANALYSIS_TIMEOUT=30000
MEMORY_LIMIT=1000000000

# Optional: Configure caching
CACHE_SIZE=1000
CACHE_TTL=3600000
```

### TypeScript Configuration

The server automatically detects and uses your project's `tsconfig.json` file for accurate type analysis.

## Usage Examples

### Basic File Analysis

```json
{
  "tool": "analyze_file",
  "params": {
    "filePath": "./src/index.ts",
    "analysisType": "all",
    "outputFormat": "detailed"
  }
}
```

### Symbol Search

```json
{
  "tool": "search_symbols",
  "params": {
    "query": "UserService",
    "searchType": "semantic",
    "symbolTypes": ["class", "interface"]
  }
}
```

### Pattern Detection

```json
{
  "tool": "find_patterns",
  "params": {
    "pattern": "console.log",
    "patternType": "ast"
  }
}
```

### Code Quality Analysis

```json
{
  "tool": "detect_code_smells",
  "params": {
    "categories": ["complexity", "naming", "unused-code"],
    "threshold": {
      "complexity": 15,
      "functionSize": 100
    }
  }
}
```

## Architecture

The server is built with a modular architecture:

- **`src/index.ts`**: MCP server setup and tool registration
- **`src/tools.ts`**: Tool implementations and schemas
- **`src/analyzer.ts`**: Core TypeScript analysis engine
- **`src/utils.ts`**: Utility functions and project management
- **`src/cache.ts`**: Intelligent caching system
- **`src/types.ts`**: TypeScript type definitions

## Testing

See `TEST_RESULTS.md` for detailed test results and examples of all tool outputs.

## License

MIT License - see LICENSE file for details.

## Requirements

- Node.js 18+
- TypeScript 5.0+
- A TypeScript project with valid `tsconfig.json`

#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  analyzeFile,
  analyzeFileSchema,
  findReferencesBySymbol,
  findReferencesBySymbolSchema,
  getCompilationErrors,
  getCompilationErrorsSchema,
} from "./tools.js";

// Create the MCP server
const server = new McpServer({
  name: "typescript-analyzer",
  version: "1.0.0",
  description: "TypeScript code analysis MCP server using ts-morph",
});

// Register tools
server.tool(
  "analyze_file",
  "Analyze a single TypeScript and get all symbols, imports, and exports. The best way to quickly understand a file using minimal context.",
  analyzeFileSchema._def.shape(),
  async (params) => {
    try {
      const validated = analyzeFileSchema.parse(params);
      const result = await analyzeFile(validated);
      return {
        content: [
          {
            type: "text",
            text:
              typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "find_references",
  "Find all references to a symbol using stable symbol identifier. Use this for perfect accuracy when searching for usage, imports, and declarations of a symbol. This is the most accurate way to find references to a symbol and understand its usage across the codebase.",
  findReferencesBySymbolSchema._def.shape(),
  async (params) => {
    try {
      const validated = findReferencesBySymbolSchema.parse(params);
      const result = await findReferencesBySymbol(validated);
      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_compilation_errors",
  "Get TypeScript compilation errors for a file or directory. Use this instead of building the project to get errors.",
  getCompilationErrorsSchema._def.shape(),
  async (params) => {
    try {
      const validated = getCompilationErrorsSchema.parse(params);
      const result = await getCompilationErrors(validated);
      return {
        content: [
          {
            type: "text",
            text:
              typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Start the server
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP TypeScript Analyzer Server running...");
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

main().catch(console.error);

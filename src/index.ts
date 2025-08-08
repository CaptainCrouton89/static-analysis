#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  analyzeFile,
  analyzeFileSchema,
  findReferences,
  findReferencesBySymbol,
  findReferencesBySymbolSchema,
  findReferencesSchema,
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
  "Analyze a single TypeScript file with configurable depth and detail",
  analyzeFileSchema._def.shape(),
  async (params) => {
    try {
      const validated = analyzeFileSchema.parse(params);
      const result = await analyzeFile(validated);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
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
  "Find all references to a symbol",
  findReferencesSchema._def.shape(),
  async (params) => {
    try {
      const validated = findReferencesSchema.parse(params);
      const result = await findReferences(validated);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
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
  "find_references_by_symbol",
  "Find all references to a symbol using stable symbol identifier",
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
  "Get TypeScript compilation errors for a file or directory",
  getCompilationErrorsSchema._def.shape(),
  async (params) => {
    try {
      const validated = getCompilationErrorsSchema.parse(params);
      const result = await getCompilationErrors(validated);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
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

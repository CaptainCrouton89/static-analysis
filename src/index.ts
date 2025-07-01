#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  analyzeFile,
  analyzeFileSchema,
  searchSymbols,
  searchSymbolsSchema,
  getSymbolInfo,
  getSymbolInfoSchema,
  findReferences,
  findReferencesSchema,
  analyzeDependencies,
  analyzeDependenciesSchema,
  findPatterns,
  findPatternsSchema,
  detectCodeSmells,
  detectCodeSmellsSchema,
  extractContext,
  extractContextSchema,
  summarizeCodebase,
  summarizeCodebaseSchema,
  getCompilationErrors,
  getCompilationErrorsSchema
} from "./tools.js";

// Create the MCP server
const server = new McpServer({
  name: "typescript-analyzer",
  version: "1.0.0",
  description: "TypeScript code analysis MCP server using ts-morph"
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
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          }
        ],
        isError: true
      };
    }
  }
);

server.tool(
  "search_symbols",
  "Search for symbols across the codebase using various strategies",
  searchSymbolsSchema._def.shape(),
  async (params) => {
    try {
      const validated = searchSymbolsSchema.parse(params);
      const result = await searchSymbols(validated);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          }
        ],
        isError: true
      };
    }
  }
);

server.tool(
  "get_symbol_info",
  "Get detailed information about a specific symbol",
  getSymbolInfoSchema._def.shape(),
  async (params) => {
    try {
      const validated = getSymbolInfoSchema.parse(params);
      const result = await getSymbolInfo(validated);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          }
        ],
        isError: true
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
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          }
        ],
        isError: true
      };
    }
  }
);

server.tool(
  "analyze_dependencies",
  "Analyze import/export dependencies",
  analyzeDependenciesSchema._def.shape(),
  async (params) => {
    try {
      const validated = analyzeDependenciesSchema.parse(params);
      const result = await analyzeDependencies(validated);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          }
        ],
        isError: true
      };
    }
  }
);


server.tool(
  "find_patterns",
  "Search for code patterns using AST matching",
  findPatternsSchema._def.shape(),
  async (params) => {
    try {
      const validated = findPatternsSchema.parse(params);
      const result = await findPatterns(validated);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          }
        ],
        isError: true
      };
    }
  }
);

// server.tool(
//   "detect_code_smells",
//   "Identify common code quality issues",
//   detectCodeSmellsSchema._def.shape(),
//   async (params) => {
//     try {
//       const validated = detectCodeSmellsSchema.parse(params);
//       const result = await detectCodeSmells(validated);
//       return {
//         content: [
//           {
//             type: "text",
//             text: JSON.stringify(result, null, 2)
//           }
//         ]
//       };
//     } catch (error) {
//       return {
//         content: [
//           {
//             type: "text",
//             text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
//           }
//         ],
//         isError: true
//       };
//     }
//   }
// );

server.tool(
  "extract_context",
  "Extract relevant context for AI understanding",
  extractContextSchema._def.shape(),
  async (params) => {
    try {
      const validated = extractContextSchema.parse(params);
      const result = await extractContext(validated);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          }
        ],
        isError: true
      };
    }
  }
);

server.tool(
  "summarize_codebase",
  "Generate high-level codebase summary",
  summarizeCodebaseSchema._def.shape(),
  async (params) => {
    try {
      const validated = summarizeCodebaseSchema.parse(params);
      const result = await summarizeCodebase(validated);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          }
        ],
        isError: true
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
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          }
        ],
        isError: true
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
#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

// Create the MCP server
const server = new McpServer({
  name: "typescript-analyzer",
  version: "1.0.0",
  description: "TypeScript code analysis MCP server using ts-morph",
});

// Parse ENABLED_TOOLS from environment
const enabledToolsEnv = process.env.ENABLED_TOOLS?.trim();
const enabledTools = enabledToolsEnv
  ? enabledToolsEnv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
  : undefined;

// Register tools based on configuration
registerTools(server, enabledTools);

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

#!/usr/bin/env node
/**
 * Executable entry point for the `any-extractor-mcp` bin.
 *
 * Runs the stdio MCP server. Intended to be launched by an MCP client
 * (Claude Desktop, Cursor, VS Code, Continue, ...) via a config like:
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "any-extractor": {
 *       "command": "npx",
 *       "args": ["-y", "any-extractor-mcp"]
 *     }
 *   }
 * }
 * ```
 */

import { runStdioServer } from './server';

runStdioServer().catch((err) => {
  console.error('[any-extractor-mcp] fatal:', err);
  process.exit(1);
});

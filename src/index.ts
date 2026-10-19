#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { runCli } from "./cli.js";
import { resolveVault } from "./config.js";
import { log } from "./logger.js";
import { createServer } from "./server.js";
import { Vault } from "./vault.js";

async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== null) {
    process.exitCode = exitCode;
    return;
  }

  const location = resolveVault();
  const vault = new Vault(location.path);
  await vault.init();

  const server = createServer(vault, location);
  await server.connect(new StdioServerTransport());
  log(`second-brain MCP server connected via stdio, vault at ${location.path} (${location.source})`);
}

main().catch((err) => {
  console.error("Fatal error starting second-brain MCP server:", err);
  process.exit(1);
});

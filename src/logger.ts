// MCP's stdio transport uses stdout exclusively for JSON-RPC traffic.
// All logging must go to stderr, and only when explicitly requested.
const DEBUG = process.env.DEBUG_MCP === "1" || process.env.DEBUG_MCP === "true";

export function log(...args: unknown[]): void {
  if (!DEBUG) return;
  console.error(`[second-brain ${new Date().toISOString()}]`, ...args);
}

import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("MCP keeps checkpoint capabilities separate from work inventory and validates the direct submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-contract-")); mkdirSync(join(root, "runtime"));
  const socket = defaultBrokerEndpoint(root), broker = TurnBroker.forSocket(socket);
  const transaction = await broker.beginCompactionTransaction("contract-proof", 15_000);
  const client = new Client({ name: "checkpoint-contract-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", socket], cwd: process.cwd(), stderr: "pipe" });
  try {
    await client.connect(transport);
    const inventory = await client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: transaction.token } });
    expect(inventory.isError).toBe(true); expect(JSON.stringify(inventory)).toContain("reserved compaction token");
    const invalid = await client.callTool({ name: "codex_tool_call", arguments: { turn_token: "control_00000000000000000000000000000000", wire_name: "codex.control.compaction_handoff", arguments: { handoff_id: transaction.handoffId, summary: "invalid" } } });
    expect(invalid.isError).toBe(true);
    const submitted = await client.callTool({ name: "codex_tool_call", arguments: { turn_token: transaction.token, wire_name: "codex.control.compaction_handoff", arguments: { handoff_id: transaction.handoffId, summary: "verified checkpoint" } } });
    expect(submitted.isError).not.toBe(true);
    expect(await broker.waitForCompactionHandoff(transaction.token)).toBe("verified checkpoint");
  } finally { await client.close(); await broker.close(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

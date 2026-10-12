import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION, toYaaaError } from '@yaaa/client';
import { MCP_INSTRUCTIONS, asJson, tools } from '@yaaa/tools';
import { context, type GlobalOpts } from '../context.js';
import { errorJson } from '../output.js';

/** `yaaa mcp`: the same operations as the CLI, as MCP tools over stdio. */
export function mcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Serve yaaa’s tools over MCP (stdio) for agents that prefer tool calls to a shell')
    .action(async (_o, cmd: Command) => {
      const { clients } = context(cmd.optsWithGlobals() as GlobalOpts);
      const server = new McpServer({ name: 'yaaa', version: VERSION }, { instructions: MCP_INSTRUCTIONS });
      for (const t of tools) {
        server.registerTool(t.name, { description: t.description, inputSchema: t.input }, async (input: Record<string, unknown>) => {
          try {
            const r = await (t.run as (c: typeof clients, i: Record<string, unknown>) => Promise<Parameters<typeof asJson>[0]>)(clients, input);
            return { content: [{ type: 'text' as const, text: JSON.stringify(asJson(r)) }] };
          } catch (e) {
            const err = toYaaaError(e);
            return {
              isError: true,
              content: [{ type: 'text' as const, text: JSON.stringify({ error: errorJson(err) }) }],
            };
          }
        });
      }
      await server.connect(new StdioServerTransport());
    });
}

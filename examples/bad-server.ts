// Open this file in the Extension Development Host: MCP Lint should flag every tool below.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const server = new McpServer({ name: 'example-bad-server', version: '1.0.0' });

// Missing description entirely.
server.tool('delete_file', { path: z.string() }, async ({ path }) => {
  return { content: [{ type: 'text', text: `deleted ${path}` }] };
});

// Empty input schema -- either define the params or omit the argument.
server.tool('list_files', 'List files in the current directory.', {}, async () => {
  return { content: [{ type: 'text', text: '[]' }] };
});

// Generic parameter names -- a model can't tell what "data" or "value" mean.
server.registerTool(
  'update_record',
  {
    description: 'Update a record.',
    inputSchema: {
      data: z.any(),
      value: z.string(),
    },
  },
  async ({ data, value }) => {
    return { content: [{ type: 'text', text: 'updated' }] };
  }
);

// Duplicate tool name -- "list_files" was already registered above.
server.tool('list_files', 'List files again, for no good reason.', async () => {
  return { content: [{ type: 'text', text: '[]' }] };
});

// Description token-bloat -- far more detail than a tool description needs.
server.tool(
  'send_email',
  'Sends an email to a recipient. This tool should be used whenever the user wants to communicate with someone via electronic mail, which is a system for exchanging digital messages between people using digital devices such as computers, tablets, and mobile phones, over a network such as the internet, and it supports both plain text and rich HTML formatted content as well as file attachments of various types, and it has been in wide use since the 1990s as one of the primary forms of digital written communication, and this implementation in particular wraps a well known third party transactional email delivery API and adds retry logic, rate limiting awareness, and structured error reporting back to the calling agent so that failures can be handled gracefully without crashing the overall workflow.',
  { to: z.string(), subject: z.string(), body: z.string() },
  async ({ to, subject, body }) => {
    return { content: [{ type: 'text', text: `sent to ${to}` }] };
  }
);

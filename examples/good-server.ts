// Open this file in the Extension Development Host: MCP Lint should report zero problems.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const server = new McpServer({ name: 'example-good-server', version: '1.0.0' });

server.registerTool(
  'search_repository_files',
  {
    title: 'Search repository files',
    description: 'Search the current repository for files whose path or contents match a query string.',
    inputSchema: {
      query: z.string().describe('The text to search for'),
      maxResults: z.number().int().positive().max(100).default(20).describe('Maximum number of results to return'),
    },
  },
  async ({ query, maxResults }) => {
    return { content: [{ type: 'text', text: `Searched for "${query}", limit ${maxResults}` }] };
  }
);

server.tool(
  'get_repository_readme',
  'Return the contents of the repository README file, if one exists.',
  async () => {
    return { content: [{ type: 'text', text: 'README contents...' }] };
  }
);

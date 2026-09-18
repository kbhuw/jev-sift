import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { classify, inputSchema, formatOutput } from './classify.js';
import { loadConfig, requireKey } from './config.js';
import { createFileReader } from './files.js';
import { createProvider } from './provider.js';

import { createWebReader } from './web.js';

const server = new McpServer({ name: 'jev-sift', version: '0.2.0' });
server.registerTool('classify', {
  title: 'Classify text and files',
  description: 'Use Jev to screen up to 50 files, public webpage URLs, or text items against a query or typed questions. Tool descriptions can be supplied as text. Pass paths or URLs directly to keep full contents out of your context. Returns relevance probabilities or typed answers; does not call candidate tools or predict unseen outputs.',
  inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
}, async (input, extra) => {
  try {
    const config = await loadConfig(); requireKey(config);
    const output = await classify(input, { model: config.model, concurrency: config.concurrency,
      evaluate: createProvider(config), readText: createFileReader(config.roots), readUrl: createWebReader(), signal: extra.signal });
    return { content: [{ type: 'text', text: formatOutput(output) }], structuredContent: output, isError: !output.ok };
  } catch (error) {
    return { content: [{ type: 'text', text: error.message || 'Classification failed.' }], isError: true };
  }
});
server.registerTool('classify_status', {
  title: 'Classifier configuration', description: 'Check local classifier configuration without calling the model or exposing credentials. Configuration presence does not prove provider connectivity.',
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => {
  try {
    const config = await loadConfig();
    const status = { configured: Boolean(config.apiKey), model: config.model, endpoint: config.endpoint, credentialPresent: Boolean(config.apiKey), fileRoots: config.roots, providerVerified: false };
    return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status };
  } catch (error) { return { content: [{ type: 'text', text: error.message }], structuredContent: { configured: false, providerVerified: false } }; }
});
await server.connect(new StdioServerTransport());

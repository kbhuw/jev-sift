import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { classify, inputSchema, formatOutput } from './classify.js';
import { loadConfig } from './config.js';
import { createFileReader } from './files.js';
import { createProvider } from './provider.js';

const server = new McpServer({ name: 'classify', version: '0.1.0' });
server.registerTool('classify', {
  title: 'Classify text and files',
  description: 'Screen up to 50 text items with boolean, choice, or score questions. For files, pass paths without reading their contents into your context first. Sends content to your configured model endpoint and returns compact answers. Probabilities are uncalibrated model estimates.',
  inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
}, async (input, extra) => {
  try {
    const config = await loadConfig();
    const output = await classify(input, { model: config.model, concurrency: config.concurrency,
      evaluate: createProvider(config), readText: createFileReader(config.roots), signal: extra.signal });
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
    const status = { configured: true, model: config.model, endpoint: config.baseUrl, credentialPresent: Boolean(config.apiKey), fileRoots: config.roots, providerVerified: false };
    return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status };
  } catch (error) { return { content: [{ type: 'text', text: error.message }], structuredContent: { configured: false, providerVerified: false } }; }
});
await server.connect(new StdioServerTransport());

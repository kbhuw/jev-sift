# Classify

**Classify first. Read selectively.**

An agent plugin that screens text and files with typed questions, so your main agent only reads the items worth opening. No framework-specific runtime, organization context, or sandbox is required.

- **Boolean:** estimated probability of yes, from 0 to 1.
- **Choice:** one of your named categories.
- **Score:** interpolated position on your ordered criteria (three rungs = 0–2).
- Up to 50 items, 8 questions, and 8 concurrent requests. Results retain input order; failures remain attached to each item.

## Plugin and MCP

The repository is the plugin package. It contains a portable Agent Plugins manifest (`plugin.json`), a bundled stdio MCP server (`mcp.json`), a Codex compatibility manifest, and a triage skill. Requires **Node.js 20+** on PATH. The checked-in `dist/server.mjs` includes its dependencies, so installed copies do not need `npm install`.

Install through a local Codex marketplace that points to this repository. On the author's machine it is available as `classify@personal`. After installing, start a new task to load its tools. See the [official plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) for adding a plugin source to your own marketplace.

For another MCP client, add this server using the absolute path to your clone:

```json
{
  "mcpServers": {
    "classify": {
      "command": "node",
      "args": ["/absolute/path/to/classify/dist/server.mjs"]
    }
  }
}
```

Tools:

- `classify_status`: reports local configuration, model, endpoint, allowed roots, and whether a credential is present. It does not contact the provider or expose credentials.
- `classify`: accepts the input shown in [examples/request.json](examples/request.json). Returns compact text plus structured answers, per-item errors, truncation flags, and reported input-token usage.

## Configure a classifier

The plugin does not include model access or credentials. Supply a chat-completions-compatible endpoint with JSON output support. No provider or model is hardcoded.

Create `~/.config/classify/config.json` (or set `CLASSIFY_CONFIG` to another absolute path):

```json
{
  "baseUrl": "https://your-provider.example/v1",
  "model": "your-model-id",
  "apiKeyEnv": "CLASSIFY_API_KEY",
  "roots": ["/absolute/path/to/documents"]
}
```

The provider receives `POST <baseUrl>/chat/completions` with `model`, `messages`, and by default `response_format: {"type":"json_object"}`. Responses must contain `choices[0].message.content` as JSON text. Endpoints that lack JSON mode can set `jsonMode: false`; returned answers are still validated.

Provide your key through an environment variable inherited by the MCP server. For desktop launches where shell environment variables are unavailable, set `apiKeyFile` to an absolute path to a private key file outside the repository. The file should contain only the key; restrict its permissions to the current user. The plugin reads it locally and never includes it in tool results.

`CLASSIFY_BASE_URL` and `CLASSIFY_MODEL` override the file. `apiKeyEnv` defaults to `CLASSIFY_API_KEY`. Optional settings: `concurrency` (1–8, default 8), `timeoutMs` (100–300000, default 60000), and `jsonMode` (default true). Local providers may omit a key. Remote endpoints require HTTPS; loopback HTTP is accepted.

For a local endpoint, [Ollama documents this API format](https://docs.ollama.com/api/openai-compatibility). Adapt [examples/config.json](examples/config.json) to a model you have installed. No local model is downloaded or started by the plugin.

`roots` defaults to `[]`, disabling file access while allowing inline text. With one root, relative paths resolve against it. With multiple roots, use absolute paths. Paths and symlinks are resolved before checking containment. Binary files and directories are rejected; file reads are bounded and text is truncated at 60,000 JavaScript characters.

Configuration is reloaded for each call. Call `classify_status`, then classify a small nonsensitive example to verify your actual provider.

## Reuse the core

After `npm ci`, use it directly in JavaScript with your own classifier and storage adapter:

```js
import { classify } from './src/classify.js';

const result = await classify(input, {
  model: 'my-classifier',
  evaluate: async ({ text, questions, signal }) => {
    // Return { answers: { question: typedAnswer }, usage?: { inputTokens } }.
    return myClassifier({ text, questions, signal });
  },
  readText: async (path, signal) => myStorage.readText(path, signal)
});
```

`evaluate` is required; `readText` is only required for paths. The core has no filesystem or provider assumptions. Typed answers are `{type:"boolean", probability:0.9}`, `{type:"choice", choice:"category"}`, or `{type:"score", score:1.7}`. Missing/extra answers, invalid categories, and out-of-range values become per-item failures.

## What this does and does not save

With paths, the tool reads and sends text to the configured classifier without the main agent first loading it into context. The classifier still processes the submitted text. Inline text already seen by the main agent does not recover that context cost.

Probabilities are model estimates, **not calibrated measurements**. Quality, latency, and cost depend on your model. The supplied source originally referenced a missing classifier implementation; this package provides a configurable replacement, not a reproduction of that model's behavior. No classification accuracy claim is made. Source text is sent to your configured endpoint; the plugin itself does not persist item content or results.

## Development and verification

```sh
npm ci
npm run build
npm test
```

Tests cover validation, concurrent ordering, partial failure, cancellation, truncation, file-root containment, model-output validation, and a real MCP client/server exchange against a **local mock HTTP provider**. The smoke test copies only the bundled server to an isolated directory to verify it does not depend on the repository's `node_modules`. These tests verify transport and behavior, not real-model accuracy or provider credentials.

After changing server source, rebuild and commit `dist/server.mjs` with the source. Reinstall the plugin to refresh its cached copy.

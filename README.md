# Jev Sift

**Let Jev decide what your agent should look at next.**

Pass a query and a batch of file paths, public webpage URLs, or text. Jev Sift reads the content, sends it directly to Jev, and returns compact relevance probabilities. Your main agent only opens the items worth a closer look.

Tool descriptions work too: pass a tool's description, arguments, and relevant context as text to judge whether calling it would help. This evaluates the supplied description; it does not execute the tool or predict its unseen result.

## Setup: one Jev API key

Get a key from the [TypeSafe dashboard](https://console.typesafe.ai/settings/keys) and provide it as **`JEV_API_KEY`** in the MCP server's environment. `TYPESAFE_API_KEY` also works.

That's the only required setting. The plugin calls `https://api.typesafe.ai/v1/systemone` with `jev-latest` directly. No endpoint, model picker, browser form, or setup UI.

For desktop hosts that do not inherit your shell environment, the plugin also reads `~/.config/jev-sift/api-key` (a private file containing just the key), or an optional `apiKeyFile` setting. Keep the key out of the repository and restrict the file to owner-only access. The plugin never includes credentials in tool responses. Webpage fetches receive no Jev credentials.

## Use it

Call `classify`:

```json
{
  "query": "Find evidence that this company sells software to hospitals",
  "items": [
    { "id": "notes", "path": "/absolute/path/to/company-notes.txt" },
    { "id": "website", "url": "https://example.com/about" },
    { "id": "candidate-tool", "text": "Tool: search_companies. Searches company profiles by industry and customer segment. Input: industry, customer_type." }
  ]
}
```

Use **exactly one** of `text`, `path`, or `url` per item. IDs must be unique. A `query` asks whether each item's contents help with your stated task and returns `answers.relevant.probability`, the probability of yes. It does not return a generated explanation.

For more control, replace `query` with 1–8 typed `questions` (see [examples/request.json](examples/request.json)):

- **Boolean:** yes-probability from 0 to 1. Mapped to Jev's native `noul` question type.
- **Choice:** one named option, including Jev's probability distribution and confidence when returned.
- **Score:** position on an ordered rubric, including Jev's distribution, confidence, and legend when returned. Three levels means a score from 0 to 2.

Up to 50 items and 8 concurrent requests. Results retain input order and include per-item errors, resolved webpage source URLs, truncation flags, and the actual model identifier when returned. Reported input-token usage is summed. Uncertain items should get a closer look; errors and truncation are not evidence that an item is irrelevant.

## Tools

| Tool | Purpose |
|---|---|
| `classify_status` | Check whether a key is available and show file roots. No network call; configuration presence alone does not prove connectivity. |
| `classify` | Screen files, webpages, or text with a query or typed questions. |

## What stays out of the agent's context

With paths and URLs, full content is loaded by this tool and sent to Jev. It does not enter the main agent's context first. Inline text the main agent has already read cannot recover that context cost.

A webpage still has to be downloaded to judge its contents. This saves the main agent from reading the page; it does not eliminate the fetch. URL fetching supports public HTML/text pages, removes scripts/styles, follows up to three redirects, and does not run JavaScript, log in, or use your browser's cookies. PDFs, private-network URLs, and other binary formats are unsupported. Some login/challenge pages can return ordinary HTML; a successful fetch does not guarantee it is the intended article.

File text and extracted page text are capped at 60,000 JavaScript characters and flagged if truncated. Web downloads have a 2 MB cap and a 20-second timeout. URLs are restricted to public IP addresses, including redirect targets; validated DNS results are pinned to connections.

By default, files inside your home directory are readable. Absolute paths are recommended. Optional file-root restrictions can be configured below. Classification content is sent to TypeSafe's Jev API. The plugin does not persist source content or classification results. Model quality on your own task still needs evaluation; transport tests are not an accuracy benchmark.

## Install as a plugin or MCP server

Requires **Node.js 20+** on PATH. The checked-in `dist/server.mjs` includes its dependencies; installed copies do not need `npm install`.

The repository is a portable Agent Plugins package with a Codex compatibility manifest. Install through a local marketplace pointing at this repository. On the author's machine it is installed as `jev-sift@personal`. Start a new task after installation or an update. See the [plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) for adding a source to another marketplace.

Any stdio MCP client can use:

```json
{
  "mcpServers": {
    "jev-sift": {
      "command": "node",
      "args": ["/absolute/path/to/jev-sift/dist/server.mjs"]
    }
  }
}
```

## Optional settings

No settings file is necessary. Advanced users can create `~/.config/jev-sift/config.json` or set `JEV_SIFT_CONFIG` to an alternate absolute path:

```json
{
  "roots": ["/absolute/path/to/documents"],
  "concurrency": 8,
  "timeoutMs": 60000
}
```

`roots: []` disables file access. With one root, relative paths resolve against it; multiple roots require absolute paths. Symlinks are resolved before containment checks. You can also set `apiKeyEnv` to a custom environment-variable name or `apiKeyFile` to an absolute private key-file path. These override the default credential source when present. The plugin does not create or modify credentials; supply the key through your host environment or a private key file.

The earlier generic prototype used `CLASSIFY_*`, `~/.config/classify/`, and a chat-completions endpoint. Those settings are no longer used. Supply a native TypeSafe/Jev API key. Existing `classify` and `classify_status` operation names remain unchanged.

## Reuse the core

After `npm ci`, import `classify` from `src/classify.js` and inject `evaluate({ text, questions, signal })`, plus `readText(path, signal)` and/or `readUrl(url, signal)` for those input types. `readUrl` returns `{text, url, truncated?}`. The core remains independent of agent frameworks; the bundled plugin uses Jev.

## Development

```sh
npm ci
npm run build
npm test
```

Tests cover native Jev request/response mapping, metadata preservation, query shorthand, concurrent ordering, failures, cancellation, truncation, file boundaries, public-URL validation, redirects, HTML extraction, and an isolated bundled MCP server exchange. Model calls in automated tests use mocks. Run a live smoke test with your key to verify actual service connectivity; neither mocks nor a handful of examples establish general accuracy.

Rebuild and commit `dist/server.mjs` after source changes. Reinstall the plugin to refresh its cached copy.

API contract: [TypeSafe HTTP reference](https://docs.typesafe.ai/api) and [quickstart](https://docs.typesafe.ai/introduction/quickstart).

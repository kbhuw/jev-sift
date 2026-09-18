# classify-tool-eve

Eve classification tool for batch evaluation of inline text or sandbox files using boolean, choice, and score questions.

The original source is preserved in `tools/classify.ts`.

## Integration

This is a source snapshot, not a standalone runnable app. It expects the host Eve project to provide:

- `eve/tools` and `zod`
- `lib/jev.ts`: `evaluateWithJev`, `jevConfigured`, `JEV_MODEL`, `JevAnswer`, and `JevResult`
- `lib/org.ts`: `requireOrgCaller`
- The Eve tool execution context and sandbox file APIs

The supporting modules were not included in the supplied source. Place the tool in your Eve project's `tools/` directory with those dependencies available.

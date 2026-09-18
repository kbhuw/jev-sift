import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import {
  evaluateWithJev,
  jevConfigured,
  JEV_MODEL,
  type JevAnswer,
  type JevResult
} from "../lib/jev.ts";
import { requireOrgCaller } from "../lib/org.ts";

const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("boolean").describe("boolean: probability the answer is yes"),
    instructions: z.string().min(1).max(500),
    criteria: z.object({ true: z.string().max(300), false: z.string().max(300) }).optional()
  }),
  z.object({
    type: z.literal("choice").describe("choice: pick one named option; criteria maps option names to short descriptions, and null is allowed"),
    instructions: z.string().min(1).max(500),
    criteria: z.record(z.string().min(1).max(60), z.string().max(300).nullable()).refine(
      (criteria) => {
        const count = Object.keys(criteria).length;
        return count >= 2 && count <= 12;
      },
      "2 to 12 options"
    )
  }),
  z.object({
    type: z.literal("score").describe("score: ordered rungs lowest to highest; the answer is an interpolated position"),
    instructions: z.string().min(1).max(500),
    criteria: z.array(z.string().max(300)).min(2).max(10)
  })
]);

const inputSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(200).describe("Your label for this item, echoed back beside its answers. Use the path for files."),
    text: z.string().max(60_000).optional().describe("The content to judge, inline."),
    path: z.string().max(1000).optional().describe("Or a file in your sandbox to judge without reading it yourself. A relative path resolves from /workspace.")
  })).min(1).max(50),
  questions: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u), questionSchema).refine(
    (questions) => {
      const count = Object.keys(questions).length;
      return count >= 1 && count <= 8;
    },
    "1 to 8 questions"
  ).describe("Typed questions to answer for every item: boolean for yes/no probability, choice for one named option, or score for an ordered rating.")
});

const CLASSIFY_STATE_CHAR_LIMIT = 60_000;
const CONCURRENCY_LIMIT = 8;

type ClassifyInput = z.infer<typeof inputSchema>;
type ClassifySuccess = {
  ok: true;
  model: typeof JEV_MODEL;
  scales: Record<string, number>;
  results: Array<{
    id: string;
    answers?: Record<string, JevAnswer>;
    truncated?: boolean;
    error?: string;
  }>;
  usage: { inputTokens: number };
};
type ClassifyOutput = ClassifySuccess | {
  ok: false;
  reason: string;
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatAnswer(answer: JevAnswer, denominator?: number): string {
  if (answer.type === "boolean") {
    return `${answer.probability >= 0.5 ? "yes" : "no"} ${answer.probability.toFixed(2)}`;
  }
  if (answer.type === "choice") {
    const probability = answer.probabilities?.[answer.choice];
    return probability === undefined ? answer.choice : `${answer.choice} ${probability.toFixed(2)}`;
  }
  const scoreDenominator = denominator ?? Math.max(1, Object.keys(answer.probabilities ?? {}).length - 1);
  return `${answer.score.toFixed(1)}/${String(scoreDenominator)}`;
}

function outputText(output: ClassifyOutput): string {
  if (!output.ok) return `Nothing was classified: ${output.reason}`;
  const lines = output.results.map((result) => {
    if (result.error) return `${result.id}: failed, ${result.error}`;
    const answers = Object.entries(result.answers ?? {}).map(([question, answer]) =>
      `${question}=${formatAnswer(answer, output.scales[question])}`
    );
    return `${result.id}: ${answers.join(", ")}${result.truncated ? " (truncated)" : ""}`;
  });
  lines.push("Probabilities are calibrated, not certainties: near 0.5 means unsure, so read those yourself.");
  return lines.join("\n");
}

const description =
  "Ask a cheap, fast classifier typed questions about many items at once, so you only read what matters. Give it files from your sandbox by path, or inline text, plus yes/no, pick-one, or rating questions, and it answers each item without the content ever entering your context. Call this before reading a directory of files, a long thread, an inbox, or search results to find the few worth opening; call it again to triage, route, or score anything you would otherwise skim. It judges text only, cannot answer open questions or explain itself, and returns calibrated probabilities: act on confident answers, and read an item yourself when it is near 0.5.";

export default defineTool({
  description,
  inputSchema,
  async execute(input: ClassifyInput, ctx): Promise<ClassifyOutput> {
    const { orgId } = requireOrgCaller(ctx);
    if (!jevConfigured()) {
      return { ok: false, reason: "The classifier is not available in this environment. Read the items yourself." };
    }

    for (const item of input.items) {
      if ((item.text !== undefined) === (item.path !== undefined)) {
        return { ok: false, reason: `Item ${item.id} must have exactly one of text or path.` };
      }
    }
    const hasPaths = input.items.some((item) => item.path !== undefined);
    const sandbox = hasPaths ? await ctx.getSandbox() : undefined;
    const prepared = await Promise.all(input.items.map(async (item) => {
      const hasPath = item.path !== undefined;
      if (!hasPath) return { id: item.id, text: item.text!, truncated: false };
      const absolute = sandbox!.resolvePath?.(item.path!) ?? item.path!;
      try {
        const text = await sandbox!.readTextFile({ path: absolute });
        if (text === null) return { id: item.id, error: `no file at ${absolute}` };
        return {
          id: item.id,
          text: text.slice(0, CLASSIFY_STATE_CHAR_LIMIT),
          truncated: text.length > CLASSIFY_STATE_CHAR_LIMIT
        };
      } catch (cause) {
        return { id: item.id, error: errorMessage(cause) };
      }
    }));

    const results: ClassifySuccess["results"] = new Array(input.items.length);
    const scales: Record<string, number> = {};
    for (const [question, value] of Object.entries(input.questions)) {
      if (value.type === "score") scales[question] = value.criteria.length - 1;
    }
    let next = 0;
    let inputTokens = 0;
    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= prepared.length) return;
        const item = prepared[index]!;
        if (item.error) {
          results[index] = { id: item.id, error: item.error };
          continue;
        }
        try {
          const result: JevResult = await evaluateWithJev({
            orgId,
            state: item.text ?? "",
            questions: input.questions
          });
          inputTokens += result.usage?.inputTokens ?? 0;
          results[index] = {
            id: item.id,
            answers: result.answers,
            ...(item.truncated ? { truncated: true } : {})
          };
        } catch (cause) {
          results[index] = { id: item.id, error: errorMessage(cause) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY_LIMIT, prepared.length) }, () => worker()));

    const output: ClassifyOutput = { ok: true, model: JEV_MODEL, scales, results, usage: { inputTokens } };
    if (results.every((result) => result.error !== undefined)) {
      return { ok: false, reason: results[0]!.error! };
    }
    return output;
  },
  toModelOutput(output) {
    return toolOutput.text(outputText(output as ClassifyOutput));
  }
});
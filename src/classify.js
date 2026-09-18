import { z } from 'zod';

export const CHAR_LIMIT = 60_000;
const questionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('boolean'), instructions: z.string().min(1).max(500),
    criteria: z.object({ true: z.string().max(300), false: z.string().max(300) }).optional() }).strict(),
  z.object({ type: z.literal('choice'), instructions: z.string().min(1).max(500),
    criteria: z.record(z.string().min(1).max(60), z.string().max(300).nullable())
      .refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 12, '2 to 12 options') }).strict(),
  z.object({ type: z.literal('score'), instructions: z.string().min(1).max(500),
    criteria: z.array(z.string().max(300)).min(2).max(10) }).strict()
]);
export const inputSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(200),
    text: z.string().max(CHAR_LIMIT).optional(),
    path: z.string().min(1).max(1000).optional()
  }).strict().refine(v => (v.text !== undefined) !== (v.path !== undefined), 'Supply exactly one of text or path'))
    .min(1).max(50).refine(v => new Set(v.map(i => i.id)).size === v.length, 'Item IDs must be unique'),
  questions: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u), questionSchema)
    .refine(v => Object.keys(v).length >= 1 && Object.keys(v).length <= 8, '1 to 8 questions')
}).strict();

export function validateAnswers(answers, questions) {
  const shape = Object.fromEntries(Object.entries(questions).map(([name, q]) => {
    let schema;
    if (q.type === 'boolean') schema = z.object({ type: z.literal('boolean'), probability: z.number().min(0).max(1) }).strict();
    if (q.type === 'choice') schema = z.object({ type: z.literal('choice'), choice: z.enum(Object.keys(q.criteria)) }).strict();
    if (q.type === 'score') schema = z.object({ type: z.literal('score'), score: z.number().min(0).max(q.criteria.length - 1) }).strict();
    return [name, schema];
  }));
  const result = z.object(shape).strict().safeParse(answers);
  if (!result.success) throw new Error('Classifier returned invalid answers: expected every question with a valid type and range.');
  return result.data;
}

/** Framework-independent entry point. Inject evaluate({ text, questions, signal }) and optionally readText(path). */
export async function classify(rawInput, { evaluate, readText, concurrency = 8, model = 'custom', signal } = {}) {
  const input = inputSchema.parse(rawInput);
  if (typeof evaluate !== 'function') throw new Error('An evaluate function is required.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Concurrency must be an integer from 1 to 8.');
  const results = new Array(input.items.length);
  const scales = Object.fromEntries(Object.entries(input.questions).filter(([, q]) => q.type === 'score').map(([name, q]) => [name, q.criteria.length - 1]));
  let next = 0, inputTokens = 0;
  async function worker() {
    while (next < input.items.length) {
      signal?.throwIfAborted();
      const index = next++, item = input.items[index];
      try {
        if (item.path !== undefined && !readText) throw new Error('File reading is not configured.');
        const raw = item.path === undefined ? item.text : await readText(item.path, signal);
        if (typeof raw !== 'string') throw new Error('File reader did not return text.');
        const truncated = raw.length > CHAR_LIMIT;
        const response = await evaluate({ text: raw.slice(0, CHAR_LIMIT), questions: input.questions, signal });
        const tokens = response.usage?.inputTokens;
        if (Number.isSafeInteger(tokens) && tokens >= 0) inputTokens += tokens;
        const answers = validateAnswers(response.answers, input.questions);
        results[index] = { id: item.id, answers, ...(truncated ? { truncated: true } : {}) };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        results[index] = { id: item.id, error: error instanceof Error ? error.message : 'Classification failed.' };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, input.items.length) }, worker));
  return { ok: results.some(r => !r.error), model, scales, results, usage: { inputTokens } };
}

export function formatOutput(output) {
  const lines = output.results.map(item => {
    if (item.error) return `${item.id}: failed, ${item.error}`;
    const answers = Object.entries(item.answers).map(([name, a]) => {
      if (a.type === 'boolean') return `${name}=${a.probability >= .5 ? 'yes' : 'no'} (P(yes)=${a.probability.toFixed(2)})`;
      if (a.type === 'choice') return `${name}=${a.choice}`;
      return `${name}=${a.score.toFixed(1)}/${output.scales[name]}`;
    });
    return `${item.id}: ${answers.join(', ')}${item.truncated ? ' (truncated)' : ''}`;
  });
  lines.push('Probabilities are model estimates, not verified calibration. Inspect uncertain items.');
  return lines.join('\n');
}

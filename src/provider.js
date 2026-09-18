import { JEV_ENDPOINT, JEV_MODEL, requireKey } from './config.js';

// Jev's native API uses `noul` for yes/no probabilities; retain the public boolean alias.
export function toJevQuestions(questions) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, {
    ...question, type: question.type === 'boolean' ? 'noul' : question.type
  }]));
}
export function fromJevAnswers(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Jev returned invalid answers.');
  return Object.fromEntries(Object.entries(answers).map(([id, answer]) => {
    if (!answer || typeof answer !== 'object') throw new Error('Jev returned invalid answers.');
    if (answer.type === 'noul') return [id, { type: 'boolean', probability: answer.noul }];
    const extras = {
      ...(answer.probabilities !== undefined ? { probabilities: answer.probabilities } : {}),
      ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {})
    };
    if (answer.type === 'choice') return [id, { type: 'choice', choice: answer.choice, ...extras }];
    if (answer.type === 'score') return [id, { type: 'score', score: answer.score, ...extras,
      ...(answer.legend !== undefined ? { legend: answer.legend } : {}) }];
    throw new Error('Jev returned an unsupported answer type.');
  }));
}
export function createProvider(config, fetcher = fetch) {
  requireKey(config);
  return async ({ text, questions, signal }) => {
    const timeout = AbortSignal.timeout(config.timeoutMs ?? 60_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetcher(JEV_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: JEV_MODEL, state: text, questions: toJevQuestions(questions) })
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new Error(timeout.aborted ? 'Jev request timed out.' : 'Cannot reach Jev.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new Error(`Jev rejected the API key (HTTP ${response.status}). Provide a valid TypeSafe/Jev key.`);
      throw new Error(`Jev HTTP ${response.status}${response.status === 429 ? ': rate limited; retry later' : ''}.`);
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Jev returned an invalid or incomplete JSON response.'); }
    return { model: data.model ?? JEV_MODEL, answers: fromJevAnswers(data.answers),
      usage: { inputTokens: data.usage?.input_tokens ?? 0 } };
  };
}

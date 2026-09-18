import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  baseUrl: z.string().url(), model: z.string().min(1),
  apiKeyEnv: z.string().min(1).default('CLASSIFY_API_KEY'),
  apiKeyFile: z.string().optional(),
  roots: z.array(z.string().min(1)).default([]),
  concurrency: z.number().int().min(1).max(8).default(8),
  timeoutMs: z.number().int().min(100).max(300_000).default(60_000),
  jsonMode: z.boolean().default(true)
}).strict();

export async function loadConfig(env = process.env) {
  const configPath = env.CLASSIFY_CONFIG || join(homedir(), '.config', 'classify', 'config.json');
  let file = {};
  try { file = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to read classifier configuration as JSON.');
    if (env.CLASSIFY_CONFIG) throw new Error('CLASSIFY_CONFIG file does not exist.');
  }
  const result = schema.safeParse({ ...file,
    ...(env.CLASSIFY_BASE_URL ? { baseUrl: env.CLASSIFY_BASE_URL } : {}),
    ...(env.CLASSIFY_MODEL ? { model: env.CLASSIFY_MODEL } : {})
  });
  if (!result.success) throw new Error('Configure baseUrl and model in ~/.config/classify/config.json or CLASSIFY_BASE_URL and CLASSIFY_MODEL. Check the README for supported configuration fields.');
  const config = result.data, url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('Model base URL must not contain credentials, query parameters, or fragments.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS for remote model endpoints (HTTP is allowed for loopback only).');
  if (config.roots.some(root => !isAbsolute(root))) throw new Error('Allowed file roots must be absolute paths.');
  let apiKey = env[config.apiKeyEnv];
  if (!apiKey && config.apiKeyFile) {
    if (!isAbsolute(config.apiKeyFile)) throw new Error('apiKeyFile must be an absolute path.');
    try { apiKey = (await readFile(config.apiKeyFile, 'utf8')).trim(); }
    catch { throw new Error('Unable to read configured API key file.'); }
  }
  return { ...config, apiKey };
}

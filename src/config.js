import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const configDir = () => join(homedir(), '.config', 'jev-sift');
export const keyPath = () => join(configDir(), 'api-key');
const schema = z.object({
  apiKeyEnv: z.string().min(1).optional(), apiKeyFile: z.string().optional(),
  roots: z.array(z.string().min(1)).default([homedir()]),
  concurrency: z.number().int().min(1).max(8).default(8),
  timeoutMs: z.number().int().min(100).max(300_000).default(60_000)
}).strict();

export async function loadConfig(env = process.env) {
  const configPath = env.JEV_SIFT_CONFIG || join(configDir(), 'config.json');
  let file = {};
  try { file = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to read Jev Sift configuration as JSON.');
    if (env.JEV_SIFT_CONFIG) throw new Error('JEV_SIFT_CONFIG file does not exist.');
  }
  const result = schema.safeParse(file);
  if (!result.success) throw new Error('Invalid Jev Sift configuration. Only apiKeyEnv, apiKeyFile, roots, concurrency, and timeoutMs are supported. Endpoint and model are built in.');
  const config = result.data;
  if (config.roots.some(root => !isAbsolute(root))) throw new Error('Allowed file roots must be absolute paths.');
  let apiKey = (config.apiKeyEnv ? env[config.apiKeyEnv] : undefined) || env.JEV_API_KEY || env.TYPESAFE_API_KEY;
  const filePath = config.apiKeyFile || keyPath();
  if (!isAbsolute(filePath)) throw new Error('apiKeyFile must be an absolute path.');
  if (!apiKey) {
    try { apiKey = (await readFile(filePath, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT' || config.apiKeyFile) throw new Error('Unable to read configured Jev API key file.'); }
  }
  return { ...config, apiKey, apiKeyFile: filePath, model: JEV_MODEL, endpoint: JEV_ENDPOINT };
}
export function requireKey(config) {
  if (!config.apiKey) throw new Error('A Jev API key is required. Set JEV_API_KEY (TYPESAFE_API_KEY also works), or provide a private apiKeyFile. No endpoint or model setting is needed.');
}

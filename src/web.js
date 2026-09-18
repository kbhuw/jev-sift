import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Parser } from 'htmlparser2';
import { CHAR_LIMIT } from './classify.js';

export function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export async function resolvePublic(rawUrl, resolveDNS = dnsLookup) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Invalid webpage URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) webpage URL without credentials.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Webpage URLs must use standard HTTP(S) ports.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Only public webpages are supported.');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveDNS(host, { all: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Only public webpages are supported; private and reserved addresses are blocked.');
  url.hash = '';
  return { url, addresses };
}
export function htmlToText(html) {
  const ignored = new Set(['script', 'style', 'noscript', 'template', 'svg']);
  const blocks = new Set(['p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'title', 'tr', 'section', 'article']);
  let skip = 0, text = '';
  const parser = new Parser({
    onopentag(name) { if (ignored.has(name)) skip++; if (!skip && blocks.has(name)) text += '\n'; },
    onclosetag(name) { if (ignored.has(name)) skip = Math.max(0, skip - 1); if (!skip && blocks.has(name)) text += '\n'; },
    ontext(part) { if (!skip) text += part; }
  }, { decodeEntities: true });
  parser.write(html); parser.end();
  return text.replace(/[\t \r]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
// Pin the already-validated DNS result to the connection, preserving hostname/TLS verification.
function requestPage(url, addresses, signal) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, { signal, agent: false, autoSelectFamily: false,
      headers: { 'User-Agent': 'jev-sift/0.2', Accept: 'text/html,text/plain,application/json' },
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }
    }, res => {
      const location = res.headers.location;
      if ([301,302,303,307,308].includes(res.statusCode) && location) { res.destroy(); resolve({ redirect: location }); return; }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); reject(new Error(`Webpage HTTP ${res.statusCode}.`)); return; }
      const type = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['text/html','application/xhtml+xml','text/plain','application/json','text/markdown'].includes(type)) { res.destroy(); reject(new Error('Unsupported webpage content type. Use an HTML or text page.')); return; }
      let bytes = 0; const chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 2_000_000) { reject(new Error('Webpage exceeds the 2 MB download limit.')); res.destroy(); } else chunks.push(chunk); });
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), type }));
      res.on('error', () => reject(new Error('Webpage download failed.')));
      res.on('aborted', () => reject(new Error('Webpage download was interrupted.')));
    });
    req.on('error', () => reject(new Error(signal.aborted ? 'Webpage request timed out or was cancelled.' : 'Unable to fetch webpage.')));
  });
}
export function createWebReader({ timeoutMs = 20_000, resolveDNS = dnsLookup, request = requestPage } = {}) {
  return async (rawUrl, signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let current = rawUrl;
    for (let redirects = 0; redirects <= 3; redirects++) {
      combined.throwIfAborted();
      const { url, addresses } = await resolvePublic(current, resolveDNS);
      const result = await request(url, addresses, combined);
      if (result.redirect) { current = new URL(result.redirect, url).href; continue; }
      const text = result.type.includes('html') ? htmlToText(result.body) : result.body.trim();
      if (!text) throw new Error('Webpage contains no readable text; it may require JavaScript or login.');
      return { text: text.slice(0, CHAR_LIMIT + 1), truncated: text.length > CHAR_LIMIT, url: url.href };
    }
    throw new Error('Webpage redirected too many times.');
  };
}

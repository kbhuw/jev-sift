import { realpath, open } from 'node:fs/promises';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { CHAR_LIMIT } from './classify.js';

export function createFileReader(roots) {
  return async (path, signal) => {
    if (!roots.length) throw new Error('File access is disabled. Configure allowed roots or provide inline text.');
    if (!isAbsolute(path) && roots.length !== 1) throw new Error('Use an absolute path when multiple roots are configured.');
    const target = await realpath(isAbsolute(path) ? path : resolve(roots[0], path));
    const allowed = await Promise.all(roots.map(root => realpath(root)));
    if (!allowed.some(root => { const rel = relative(root, target); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); })) throw new Error('File path is outside the configured roots.');
    const handle = await open(target, 'r');
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Path is not a regular file.');
      let text = '';
      const stream = handle.createReadStream({ encoding: 'utf8', highWaterMark: 8192, autoClose: false, signal });
      try {
        for await (const chunk of stream) {
          if (chunk.includes('\0')) throw new Error('Binary files are not supported.');
          text += chunk;
          if (text.length > CHAR_LIMIT) break;
        }
      } finally { stream.destroy(); }
      return text.slice(0, CHAR_LIMIT + 1);
    } finally { await handle.close(); }
  };
}

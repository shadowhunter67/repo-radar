import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { responseHeaders } from './headers.js';
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
export async function serveStatic(
  root: string,
  pathname: string,
  res: ServerResponse,
): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (
    !decoded.startsWith('/') ||
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.split('/').some((x) => x === '..' || x === '.') ||
    decoded.startsWith('//')
  )
    return false;
  const name = decoded === '/' ? '/index.html' : decoded;
  if (!/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(name)) return false;
  const file = join(root, name.slice(1));
  try {
    const data = await readFile(file);
    const dot = file.lastIndexOf('.');
    res.writeHead(200, {
      ...responseHeaders(false),
      'Content-Type': types[file.slice(dot)] ?? 'application/octet-stream',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

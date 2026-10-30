import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { responseHeaders } from './headers.js';
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
export async function serveStatic(
  root: string,
  pathname: string,
  res: ServerResponse,
  /** Text for the build marker of the landing page (the deployed version and commit). */
  buildInfo?: string,
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
    let data = await readFile(file);
    if (buildInfo !== undefined && file.endsWith('index.html')) {
      const escaped = buildInfo.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      data = Buffer.from(data.toString('utf8').replace('<!--build-info-->', escaped));
    }
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

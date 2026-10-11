/**
 * Minimal, safe, non-validating XML reader for POM-like documents.
 *
 * Security model (repository content is hostile):
 *  - A DOCTYPE or ENTITY declaration makes the whole document unreadable: there is no DTD processing, no external
 *    entity, no entity expansion of any kind (XXE and "billion laughs" are impossible by construction);
 *  - only the five predefined entities and numeric character references are decoded; an unknown `&name;` stays literal;
 *  - size, depth, node, attribute and text length are bounded; exceeding a bound aborts with a reason, never partial trust;
 *  - nothing is fetched, evaluated or resolved: namespaces are ignored, processing instructions are skipped.
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  /** Direct text (concatenated, trimmed). */
  text: string;
  children: XmlNode[];
}

export const XML_LIMITS = {
  maxBytes: 1024 * 1024,
  maxDepth: 64,
  maxNodes: 20_000,
  maxAttrs: 20,
  maxText: 4000,
} as const;

export type XmlResult = { ok: true; root: XmlNode } | { ok: false; reason: string };

const ENTITY: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{1,8});/g, (m, e: string) => {
    if (e.startsWith('#x')) return safeCode(parseInt(e.slice(2), 16), m);
    if (e.startsWith('#')) return safeCode(parseInt(e.slice(1), 10), m);
    return ENTITY[e] ?? m;
  });
}
const safeCode = (n: number, fallback: string): string =>
  Number.isFinite(n) && n > 31 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : fallback;

export function parseXml(text: string): XmlResult {
  if (text.length > XML_LIMITS.maxBytes) return { ok: false, reason: 'document too large' };
  // Reject DTDs/entities up front, case-insensitively, before any tokenization.
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text))
    return { ok: false, reason: 'DOCTYPE/ENTITY declarations are not processed' };
  const root: XmlNode = { name: '#document', attrs: {}, text: '', children: [] };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      appendText(stack[stack.length - 1] as XmlNode, text.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1] as XmlNode, text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return { ok: false, reason: 'unterminated comment' };
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) return { ok: false, reason: 'unterminated CDATA' };
      appendText(stack[stack.length - 1] as XmlNode, text.slice(lt + 9, end), true);
      i = end + 3;
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) return { ok: false, reason: 'unterminated processing instruction' };
      i = end + 2;
    } else if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end < 0) return { ok: false, reason: 'unterminated end tag' };
      if (stack.length <= 1) return { ok: false, reason: 'unbalanced end tag' };
      stack.pop();
      i = end + 1;
    } else {
      const end = findTagEnd(text, lt + 1);
      if (end < 0) return { ok: false, reason: 'unterminated tag' };
      const raw = text.slice(lt + 1, end);
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const m = /^([A-Za-z_][\w.:-]{0,100})/.exec(body);
      if (!m) return { ok: false, reason: 'malformed tag name' };
      if (++nodes > XML_LIMITS.maxNodes) return { ok: false, reason: 'too many elements' };
      const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
      let count = 0;
      const attrRe = /([A-Za-z_][\w.:-]{0,100})\s*=\s*(?:"([^"]{0,500})"|'([^']{0,500})')/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(body.slice(m[0].length))) && count++ < XML_LIMITS.maxAttrs)
        attrs[a[1] as string] = decode((a[2] ?? a[3]) as string);
      const node: XmlNode = {
        name: (m[1] as string).replace(/^[^:]*:/, ''),
        attrs,
        text: '',
        children: [],
      };
      (stack[stack.length - 1] as XmlNode).children.push(node);
      if (!selfClosing) {
        stack.push(node);
        if (stack.length > XML_LIMITS.maxDepth + 1)
          return { ok: false, reason: 'nesting too deep' };
      }
      i = end + 1;
    }
  }
  if (stack.length !== 1) return { ok: false, reason: 'unclosed element' };
  const first = root.children[0];
  return first ? { ok: true, root: first } : { ok: false, reason: 'no root element' };
}

/** Index of the `>` that ends the tag starting at `from`, skipping quoted attribute values. */
function findTagEnd(text: string, from: number): number {
  let quote = '';
  for (let j = from; j < text.length && j < from + 20_000; j++) {
    const c = text[j] as string;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return -1;
}

function appendText(node: XmlNode, raw: string, literal = false): void {
  if (node.text.length >= XML_LIMITS.maxText) return;
  const t = literal ? raw : decode(raw);
  node.text = (node.text + t).trim().slice(0, XML_LIMITS.maxText);
}

/** First direct child with this (namespace-stripped) name. */
export const child = (n: XmlNode | undefined, name: string): XmlNode | undefined =>
  n?.children.find((c) => c.name === name);
export const children = (n: XmlNode | undefined, name: string): XmlNode[] =>
  n?.children.filter((c) => c.name === name) ?? [];
export const textOf = (n: XmlNode | undefined, name: string): string | undefined => {
  const t = child(n, name)?.text;
  return t ? t : undefined;
};

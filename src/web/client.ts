import { isIP } from 'node:net';

/**
 * Key used for per-client rate limiting. IPv4 is used as is; IPv4-mapped IPv6 is reduced to its IPv4 address; any other IPv6
 * address is reduced to its /64 prefix, because one subscriber normally controls a whole /64 and per-address limits would be
 * trivially bypassed by rotating inside it. The key is never logged raw (see `clientHash`).
 */
export function clientKey(address: string | undefined): string {
  if (!address) return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  const a = (mapped ? mapped[1]! : address).split('%')[0]!;
  const kind = isIP(a);
  if (kind === 4) return a;
  if (kind === 6) return `v6:${expandV6(a).slice(0, 4).join(':')}`;
  return 'unknown';
}

function expandV6(a: string): string[] {
  let addr = a.toLowerCase();
  // an embedded IPv4 tail (::1.2.3.4) becomes two groups
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (tail) {
    const n = tail.slice(1).map(Number);
    addr =
      addr.slice(0, tail.index) +
      ((n[0]! << 8) | n[1]!).toString(16) +
      ':' +
      ((n[2]! << 8) | n[3]!).toString(16);
  }
  const [head, rest] = addr.split('::');
  const h = head ? head.split(':') : [];
  const r = rest === undefined ? [] : rest ? rest.split(':') : [];
  const fill =
    rest === undefined ? [] : Array<string>(Math.max(0, 8 - h.length - r.length)).fill('0');
  return [...h, ...fill, ...r].map((g) => g.padStart(4, '0'));
}

/**
 * The address that identifies the caller. Forwarded headers are honoured ONLY when TRUST_PROXY is set, and then only the LAST
 * entry (the one the single trusted proxy appended); a malformed value falls back to the socket address.
 */
export function clientAddress(
  forwardedFor: string | string[] | undefined,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const raw = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const last = raw?.split(',').at(-1)?.trim();
    if (last && isIP(last.split('%')[0]!)) return clientKey(last);
  }
  return clientKey(socketAddress);
}

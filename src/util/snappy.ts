/**
 * Snappy RAW block decompression (https://github.com/google/snappy/blob/main/format_description.txt), the encoding GitHub's
 * attestation store uses for large Sigstore bundles. It is data decompression only: no cryptography.
 *
 * The input is attacker-reachable, so the decoder is strict and bounded:
 *  - the declared output length is read first and rejected above `maxOutput` BEFORE anything is allocated;
 *  - every literal and copy is bounds-checked against the input and the output;
 *  - a copy offset of zero or beyond the data produced so far is an error;
 *  - the decoded length must equal the declared length exactly.
 * Any violation returns `undefined`; there is no partial output.
 */
export function snappyDecompress(input: Uint8Array, maxOutput: number): Buffer | undefined {
  let pos = 0;
  // varint: uncompressed length (at most 5 bytes for a 32-bit length)
  let declared = 0;
  let shift = 0;
  for (;;) {
    if (pos >= input.length || shift > 28) return undefined;
    const b = input[pos++] as number;
    declared += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  if (!Number.isSafeInteger(declared) || declared > maxOutput) return undefined;
  const out = Buffer.allocUnsafe(declared);
  let o = 0;
  while (pos < input.length) {
    const tag = input[pos++] as number;
    const kind = tag & 3;
    if (kind === 0) {
      // literal
      let len = tag >> 2;
      if (len >= 60) {
        const extra = len - 59; // 1..4 length bytes, little endian
        if (pos + extra > input.length) return undefined;
        len = 0;
        for (let i = 0; i < extra; i++) len += (input[pos + i] as number) * 2 ** (8 * i);
        pos += extra;
      }
      len += 1;
      if (pos + len > input.length || o + len > declared) return undefined;
      out.set(input.subarray(pos, pos + len), o);
      pos += len;
      o += len;
    } else {
      let len: number;
      let offset: number;
      if (kind === 1) {
        // copy with a 1-byte offset: length 4..11, offset 11 bits
        if (pos >= input.length) return undefined;
        len = 4 + ((tag >> 2) & 7);
        offset = ((tag >> 5) << 8) | (input[pos++] as number);
      } else if (kind === 2) {
        // copy with a 2-byte offset: length 1..64
        if (pos + 2 > input.length) return undefined;
        len = 1 + (tag >> 2);
        offset = (input[pos] as number) | ((input[pos + 1] as number) << 8);
        pos += 2;
      } else {
        // copy with a 4-byte offset
        if (pos + 4 > input.length) return undefined;
        len = 1 + (tag >> 2);
        offset =
          (input[pos] as number) +
          (input[pos + 1] as number) * 2 ** 8 +
          (input[pos + 2] as number) * 2 ** 16 +
          (input[pos + 3] as number) * 2 ** 24;
        pos += 4;
      }
      if (offset === 0 || offset > o || o + len > declared) return undefined;
      // overlapping copies are legal (run-length style): copy byte by byte
      for (let i = 0; i < len; i++) out[o + i] = out[o - offset + i] as number;
      o += len;
    }
  }
  return o === declared ? out : undefined;
}

/**
 * Bounded metadata of a downloaded file, read from its first bytes. Nothing is loaded into the host runtime or executed;
 * this reads a few header fields (executable format, CPU architecture, platform) and leaves everything else alone. It is
 * not reverse engineering and says nothing about what the program does.
 */
export interface BinaryMeta {
  format:
    | 'elf'
    | 'pe'
    | 'macho'
    | 'macho-universal'
    | 'script'
    | 'zip'
    | 'gzip'
    | 'xz'
    | 'bzip2'
    | 'tar'
    | 'unknown';
  architecture: string | null;
  platform: string | null;
  /** Interpreter of a script (`#!/bin/sh`), sanitized. */
  interpreter: string | null;
}

const ELF_MACHINE: Record<number, string> = {
  0x03: 'x86',
  0x3e: 'x86-64',
  0x28: 'arm',
  0xb7: 'aarch64',
  0xf3: 'riscv',
  0x08: 'mips',
  0x14: 'ppc',
  0x15: 'ppc64',
  0x16: 's390x',
  0x102: 'loongarch',
};
const PE_MACHINE: Record<number, string> = {
  0x14c: 'x86',
  0x8664: 'x86-64',
  0x1c0: 'arm',
  0x1c4: 'arm',
  0xaa64: 'aarch64',
};
const MACHO_CPU: Record<number, string> = {
  7: 'x86',
  0x01000007: 'x86-64',
  12: 'arm',
  0x0100000c: 'aarch64',
};

export function binaryMeta(bytes: Uint8Array): BinaryMeta {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 4096));
  const none: BinaryMeta = {
    format: 'unknown',
    architecture: null,
    platform: null,
    interpreter: null,
  };
  if (b.length < 4) return none;
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) {
    if (b.length < 20) return { ...none, format: 'elf' };
    const le = b[5] === 1;
    const machine = le ? b.readUInt16LE(18) : b.readUInt16BE(18);
    const osabi = b[7] as number;
    return {
      format: 'elf',
      architecture: ELF_MACHINE[machine] ?? `machine-0x${machine.toString(16)}`,
      platform:
        osabi === 0 || osabi === 3 ? 'linux/unix' : osabi === 9 ? 'freebsd' : `osabi-${osabi}`,
      interpreter: null,
    };
  }
  if (b[0] === 0x4d && b[1] === 0x5a) {
    if (b.length >= 0x40) {
      const off = b.readUInt32LE(0x3c);
      if (off + 6 <= b.length && b.toString('latin1', off, off + 4) === 'PE\u0000\u0000')
        return {
          format: 'pe',
          architecture: PE_MACHINE[b.readUInt16LE(off + 4)] ?? 'unknown',
          platform: 'windows',
          interpreter: null,
        };
    }
    return { ...none, format: 'pe', platform: 'windows' };
  }
  const be = b.readUInt32BE(0);
  const le32 = b.readUInt32LE(0);
  if (be === 0xcafebabe && b.length >= 8 && b.readUInt32BE(4) < 40)
    return {
      format: 'macho-universal',
      architecture: 'universal',
      platform: 'macos',
      interpreter: null,
    };
  if (be === 0xfeedface || be === 0xfeedfacf)
    return {
      format: 'macho',
      architecture: b.length >= 8 ? (MACHO_CPU[b.readUInt32BE(4)] ?? 'unknown') : null,
      platform: 'macos',
      interpreter: null,
    };
  if (le32 === 0xfeedface || le32 === 0xfeedfacf)
    return {
      format: 'macho',
      architecture: b.length >= 8 ? (MACHO_CPU[b.readUInt32LE(4)] ?? 'unknown') : null,
      platform: 'macos',
      interpreter: null,
    };
  if (b[0] === 0x23 && b[1] === 0x21) {
    const line = b.toString('latin1', 2, Math.min(b.length, 120)).split('\n')[0] ?? '';
    return {
      ...none,
      format: 'script',
      interpreter: [...line]
        .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127)
        .join('')
        .trim()
        .slice(0, 60),
    };
  }
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5))
    return { ...none, format: 'zip' };
  if (b[0] === 0x1f && b[1] === 0x8b) return { ...none, format: 'gzip' };
  if (b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a) return { ...none, format: 'xz' };
  if (b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68) return { ...none, format: 'bzip2' };
  if (b.length >= 262 && b.toString('latin1', 257, 262) === 'ustar')
    return { ...none, format: 'tar' };
  return none;
}

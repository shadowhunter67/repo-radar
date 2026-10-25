export function sha256(bytes: Uint8Array): string;
export function buildMetadata(input: {
  version: string;
  node: string;
  npm: string;
  commit: string;
  commands: string[];
}): {
  name: string;
  version: string;
  node: string;
  npm: string;
  commit: string;
  commands: string[];
};
export function inspectPackageEntries(entries: string[]): { entries: number; forbidden: string[] };

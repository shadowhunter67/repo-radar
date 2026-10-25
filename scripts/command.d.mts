export function commandInvocation(
  command: string,
  args: string[],
  platform?: string,
  npmExecPath?: string,
): { command: string; args: string[]; shell: boolean };
export function execFixed(
  command: string,
  args: string[],
  options?: Record<string, unknown>,
): Buffer | string;

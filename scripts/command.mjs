import { execFileSync } from 'node:child_process';
import process from 'node:process';

export function commandInvocation(
  command,
  args,
  platform = process.platform,
  npmExecPath = process.env.npm_execpath,
) {
  if (command === 'npm' && npmExecPath)
    return { command: process.execPath, args: [npmExecPath, ...args], shell: false };
  if (command === 'npm' && platform === 'win32') return { command: 'npm.cmd', args, shell: true };
  return { command, args, shell: false };
}

export function execFixed(command, args, options = {}) {
  const invocation = commandInvocation(command, args);
  return execFileSync(invocation.command, invocation.args, { ...options, shell: invocation.shell });
}

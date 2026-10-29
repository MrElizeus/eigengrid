/** Do not print credential-bearing commands into terminal scrollback. */
export function redactCommand(command: string): string {
  if (/^\/key\s+(?!--forget(?:\s|$))/i.test(command)) return "/key [hidden]";
  return command.replace(/^(\/models?\s+set\s+apiKey)\s+.+$/i, "$1 [hidden]");
}

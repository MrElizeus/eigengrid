/**
 * Stable key generation for rendered message elements.
 *
 * RULE: No rendered element should use a key based only on local line index.
 *
 * CORRECT: `${message.id}-paragraph-${i}`
 * WRONG:   `line-${i}`
 */
export function lineKey(messageId: string, kind: string, index: number): string {
  return `${messageId}-${kind}-${index}`;
}

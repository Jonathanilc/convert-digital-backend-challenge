/**
 * Extracts `@username` mentions. The `@` must start a word (so e-mail addresses don't count), the
 * name must be a valid username, and it must not continue into a longer token such as
 * `@this-has-dashes`. Returns lower-cased, de-duplicated names in order of first appearance.
 */
const MENTION = /(?<![\w@])@([A-Za-z0-9_]{3,32})(?![\w-])/g;

export function extractMentionUsernames(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION)) {
    const name = (match[1] as string).toLowerCase();
    if (!seen.has(name)) seen.add(name);
  }
  return [...seen];
}

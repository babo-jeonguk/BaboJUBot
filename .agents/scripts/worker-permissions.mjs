// The files the code worker may not edit, read from its definition (.opencode/agents/dev-worker.md) the way OpenCode
// applies the permissions. check-worker-change.mjs judges a worker's change with it, and worker-permissions.test.mjs
// keeps the denied files in line with the repository's test scope. Contract: docs/agents/worker.md.
import { parse } from "yaml";

// `*` in a pattern matches any characters, `/` included, as in OpenCode permissions.
export function matcher(pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${source}$`, "s");
}

/** The edit rules of a worker definition, or undefined when it has no frontmatter. */
export function editRules(definition) {
  const frontmatter = definition.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!frontmatter) return undefined;
  return parse(frontmatter)
    .permissions.filter((rule) => rule.action === "edit")
    .map((rule) => ({ ...rule, matches: matcher(rule.resource) }));
}

/** OpenCode applies the last rule that matches, so a later allow can reopen a denied path. */
export function isProtected(rules, file) {
  return rules.findLast((rule) => rule.matches.test(file))?.effect === "deny";
}

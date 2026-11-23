// The files the code worker may not edit, read from its definition (.opencode/agents/dev-worker.md) the way OpenCode
// applies the permissions. check-worker-change.ts judges a worker's change with it, and worker-permissions.test.ts
// keeps the denied files in line with the repository's test scope. Contract: docs/agents/worker.md.
import { parse } from "yaml";

/** One edit permission of a worker definition, with the matcher of its resource pattern. */
export interface EditRule {
  action: "edit";
  resource: string;
  effect: string;
  matches: RegExp;
}

// `*` in a pattern matches any characters, `/` included, as in OpenCode permissions.
export function matcher(pattern: string) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${source}$`, "s");
}

/** The permission list of a definition's frontmatter. A rule that is not action, resource and effect text is a broken definition. */
function permissions(frontmatter: unknown) {
  if (
    typeof frontmatter !== "object" ||
    frontmatter === null ||
    !("permissions" in frontmatter) ||
    !Array.isArray(frontmatter.permissions)
  )
    throw new Error("the worker definition has no permissions list");
  return frontmatter.permissions.map((rule: unknown) => {
    if (
      typeof rule !== "object" ||
      rule === null ||
      !("action" in rule) ||
      !("resource" in rule) ||
      !("effect" in rule) ||
      typeof rule.action !== "string" ||
      typeof rule.resource !== "string" ||
      typeof rule.effect !== "string"
    )
      throw new Error(
        `a permission of the worker definition is not action, resource and effect text: ${JSON.stringify(rule)}`
      );
    return {
      action: rule.action,
      resource: rule.resource,
      effect: rule.effect,
    };
  });
}

/** The edit rules of a worker definition, or undefined when it has no frontmatter. */
export function editRules(definition: string): EditRule[] | undefined {
  const frontmatter = definition.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!frontmatter) return undefined;
  return permissions(parse(frontmatter)).flatMap((rule) =>
    rule.action === "edit"
      ? [{ ...rule, action: "edit", matches: matcher(rule.resource) }]
      : []
  );
}

/** OpenCode applies the last rule that matches, so a later allow can reopen a denied path. */
export function isProtected(rules: EditRule[], file: string) {
  return rules.findLast((rule) => rule.matches.test(file))?.effect === "deny";
}

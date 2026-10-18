import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [".gitignore", "AGENTS.md", "GLOSSARY.md", "docs/features.md"];
for (const location of required)
  assert(fs.existsSync(path.join(root, location)), `Missing ${location}`);

let markdownFiles = 0;
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      [
        ".git",
        "node_modules",
        ".babojubot",
        ".venv",
        ".pnpm-store",
        ".reference-cache",
        ".scratch",
      ].includes(entry.name)
    )
      continue;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) inspect(location);
    else if (entry.name.endsWith(".md")) {
      markdownFiles++;
      const content = fs.readFileSync(location, "utf8");
      for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const local = target.split("#")[0];
        assert(
          fs.existsSync(path.resolve(path.dirname(location), local)),
          `Broken local link ${location}: ${target}`
        );
      }
    }
  }
}
inspect(root);
console.log(
  `Checked local links in ${markdownFiles} Markdown files. No product functionality was tested.`
);

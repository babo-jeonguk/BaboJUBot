// Reading fields of JSON the agent tools did not write (opencode's event lines, a reference app's requests). Such data is
// `unknown` until its shape is checked: a field is read only from an object, and only as the type it turns out to have.
// run-worker.ts and the reference-first mock-llm.ts read through these.

/** A field of a JSON object; undefined when the value is not an object (or is an array) or has no such field. */
export function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  for (const [name, item] of Object.entries(value))
    if (name === key) return item;
  return undefined;
}

/** A text field; undefined when it is missing or not text. */
export function textField(value: unknown, key: string): string | undefined {
  const item = field(value, key);
  return typeof item === "string" ? item : undefined;
}

/** A number field; undefined when it is missing or not a number. */
export function numberField(value: unknown, key: string): number | undefined {
  const item = field(value, key);
  return typeof item === "number" ? item : undefined;
}

/** An array field; undefined when it is missing or not an array. */
export function listField(value: unknown, key: string): unknown[] | undefined {
  const item = field(value, key);
  return Array.isArray(item) ? item : undefined;
}

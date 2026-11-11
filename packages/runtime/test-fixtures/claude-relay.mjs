// Synthetic Claude stand-in for the credential relay tests (#148). No model or network requests beyond the given relay.
// Reads the first user turn, announces a session, then calls the Messages API at ANTHROPIC_BASE_URL with the grant in
// CLAUDE_CODE_OAUTH_TOKEN. On 200 it finishes; otherwise it keeps retrying like a CLI would until its input closes, then exits 1.
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
await input.next();
console.log(
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "relay-session",
  })
);
const call = () =>
  fetch(
    new URL("v1/messages?beta=true", process.env.ANTHROPIC_BASE_URL + "/"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "synthetic" }),
    }
  ).then(
    (response) => response.status,
    () => 0
  );
const first = await call();
if (first === 200) {
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "relay-session",
      result: "done",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  );
  process.exit(0);
}
let closed = false;
void (async () => {
  for (;;) if ((await input.next()).done) break;
  closed = true;
})();
while (!closed) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await call();
}
process.exit(1);

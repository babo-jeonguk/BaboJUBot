// Manual model invocation. Never imported by CI or the automatic test suite.
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createClaudeProvider,
  createCodexProvider,
  createOpenCodeProvider,
  createAntigravityProvider,
} from "../packages/runtime/src/index.ts";
import { openEphemeralDatabase } from "../packages/db/src/index.ts";
import { startServer } from "../apps/server/src/index.ts";
const [provider, consent] = process.argv.slice(2);
const factories = {
  claude: createClaudeProvider,
  codex: createCodexProvider,
  opencode: createOpenCodeProvider,
  antigravity: createAntigravityProvider,
};
if (
  !(provider in factories) ||
  consent !== "--allow-live" ||
  !process.env.BABOJUBOT_HOME
) {
  console.error(
    "Usage: BABOJUBOT_HOME=/absolute/product/home node scripts/provider-smoke.mjs <claude|codex|opencode|antigravity> --allow-live"
  );
  console.error(
    "Requires product login and explicit permission to use subscription/model quota."
  );
  process.exit(2);
}
const model =
  process.env.BABOJUBOT_SMOKE_MODEL ?? (provider === "claude" ? "haiku" : null);
if (!model && provider !== "opencode") {
  console.error(
    "Set BABOJUBOT_SMOKE_MODEL to the cheapest model available to your product account after checking its current catalog/pricing."
  );
  process.exit(2);
}
const connection = factories[provider]({
  dataDir: path.resolve(process.env.BABOJUBOT_HOME),
  ...(provider === "codex"
    ? {
        mode:
          process.env.BABOJUBOT_CODEX_MODE === "exec" ? "exec" : "app-server",
      }
    : {}),
});
const controller = new AbortController();
const ready = await connection.adapter.checkReadiness(controller.signal);
console.log("readiness:", ready);
if (ready.status === "not_ready") process.exit(1);
const workspace = await mkdtemp(path.join(tmpdir(), "babojubot-smoke-")),
  database = await openEphemeralDatabase();
let server;
const timer = setTimeout(() => controller.abort(), 60000);
try {
  server = await startServer({
    db: database.db,
    dataDir: workspace,
    port: 0,
    providers: [
      {
        ...connection,
        adapter: {
          ...connection.adapter,
          execute(input, control) {
            return connection.adapter.execute(
              {
                ...input,
                instructions: [
                  {
                    path: "AGENTS.md",
                    content:
                      'This is a short connectivity test. Call get_run_context once, then send_message with body "OK" once in the default owner conversation. Do not call other tools, start research, or create files. End immediately afterward.',
                  },
                ],
              },
              {
                ...control,
                signal: AbortSignal.any([control.signal, controller.signal]),
              }
            );
          },
        },
      },
    ],
  });
  const created = await fetch(server.url + "/api/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Provider smoke",
      goal: "Call get_run_context and reply OK once.",
      completionCriteria: "One context tool call and one short owner reply.",
      lead: { provider: connection.id, model },
    }),
  });
  if (!created.ok)
    throw new Error("Could not create isolated smoke organization");
  const organization = await created.json();
  await server.drain();
  const runs = await (
    await fetch(`${server.url}/api/organizations/${organization.id}/runs`)
  ).json();
  const conversation = await (
    await fetch(`${server.url}/api/organizations/${organization.id}/messages`)
  ).json();
  const run = runs[0];
  const detail = await (
    await fetch(
      `${server.url}/api/organizations/${organization.id}/runs/${run.id}`
    )
  ).json();
  const reply = conversation.messages.some(
    (message) => message.author === "agent" && message.body.trim() === "OK"
  );
  const contextCalled = detail.transcript.some(
    (event) =>
      event.type === "run.activity" &&
      event.payload.activity.activity?.type === "org_tool" &&
      event.payload.activity.activity.tool === "get_run_context"
  );
  // Print metadata only. Product events retain the tool activity; no raw model output or token is captured.
  console.log(
    JSON.stringify(
      {
        provider,
        model: model ?? "catalog-free",
        status: run.status,
        oneLineReply: reply,
        contextCalled,
        usage: detail.usage ?? null,
      },
      null,
      2
    )
  );
  process.exitCode =
    run.status === "completed" && reply && contextCalled ? 0 : 1;
} finally {
  clearTimeout(timer);
  controller.abort();
  await server?.close();
  await database.close();
  await rm(workspace, { recursive: true, force: true });
}

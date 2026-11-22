// Manual model invocation. Never imported by CI or the automatic test suite.
import path from "node:path";
import {
  createClaudeProvider,
  createCodexProvider,
  createOpenCodeProvider,
  createAntigravityProvider,
} from "@babojubot/runtime";
import {
  conversationPageSchema,
  organizationDetailSchema,
  runDetailSchema,
  runSummaryListSchema,
} from "@babojubot/contracts";
import { openEphemeralDatabase } from "@babojubot/db";
import { startServer } from "@babojubot/server";
import { withCheckServer } from "./live/check-server.mjs";
const [provider, consent] = process.argv.slice(2);
const factories = {
  claude: createClaudeProvider,
  codex: createCodexProvider,
  opencode: createOpenCodeProvider,
  antigravity: createAntigravityProvider,
};
if (
  provider === undefined ||
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
/** 서버를 띄운다. 임시 폴더·DB와 함께 withCheckServer가 확인 뒤에 모두 정리한다. */
const startSmokeServer = ({ database, workspace }) =>
  startServer({
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

/** 조직 하나를 만들어 한 번 답하는지 본다. 끝나면(실패해도) 진행 중인 실행을 멈춰 서버가 닫힐 수 있게 한다. */
async function smoke({ server }) {
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    await check(server);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function check(server) {
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
  // 응답은 화면(apps/web/src/api.ts)과 같은 계약 스키마로 읽는다.
  const organization = organizationDetailSchema.parse(await created.json());
  await server.drain();
  const runs = runSummaryListSchema.parse(
    await (
      await fetch(`${server.url}/api/organizations/${organization.id}/runs`)
    ).json()
  );
  const conversation = conversationPageSchema.parse(
    await (
      await fetch(`${server.url}/api/organizations/${organization.id}/messages`)
    ).json()
  );
  const run = runs[0];
  if (!run) throw new Error("The smoke organization has no run");
  const detail = runDetailSchema.parse(
    await (
      await fetch(
        `${server.url}/api/organizations/${organization.id}/runs/${run.id}`
      )
    ).json()
  );
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
}

await withCheckServer(
  {
    prefix: "babojubot-smoke-",
    openDatabase: openEphemeralDatabase,
    startServer: startSmokeServer,
  },
  smoke
);

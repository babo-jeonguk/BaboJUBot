import {
  mkdtemp,
  writeFile,
  rm,
  symlink,
  mkdir,
  stat,
  link,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/app.ts";
import { afterEach, expect, it } from "vitest";
import { createGate } from "@babojubot/runtime/testing";
import {
  artifactSchema,
  runSummaryListSchema,
  type RunRequest,
} from "@babojubot/contracts";
import { scriptedAgents, serverHelpers, calls, idle } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";
let t: TestServer | undefined;
let root = "";
afterEach(async () => {
  await t?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
it("passes organization and personal folders, freezes files, replays across HTTP/MCP after deletion, and refuses escaping paths", async () => {
  root = await mkdtemp(path.join(tmpdir(), "artifact-test-"));
  const agents = scriptedAgents();
  t = await startTestServer({ runtime: agents.runtime, dataDir: root });
  const { researching, say, tasksOf } = serverHelpers(() => t!);
  const org = await researching(agents, "파일 조직");
  agents.queue(org.workers[0]!.id, idle);
  agents.queue(
    org.lead.id,
    calls({
      tool: "create_task",
      input: { title: "파일 검증", assigneeAgentId: org.workers[0]!.id },
    })
  );
  await say(org.id, "작업 만들기");
  await t.drain();
  const task = (await tasksOf(org.id))[0]!;
  const gate = createGate();
  let request!: RunRequest;
  agents.queue(org.lead.id, (r) => {
    request = r;
    return { steps: [{ do: "hold", until: gate.wait }] };
  });
  await say(org.id, "등록");
  await gate.reached;
  const workspace = request.workspace!;
  expect(workspace.cwd).toBe(workspace.organization);
  expect(workspace.personal).toContain(org.lead.id);
  expect(workspace.peers?.map((p) => p.agentId).sort()).toEqual(
    org.workers.map((a) => a.id).sort()
  );
  expect((await stat(workspace.personal!)).isDirectory()).toBe(true);
  for (const peer of workspace.peers!)
    expect((await stat(peer.path)).isDirectory()).toBe(true);
  await writeFile(path.join(workspace.cwd, "보고서.md"), "# 등록 원문\n근거");
  const input = { taskId: task.id, title: "실험 보고서", path: "보고서.md" };
  const headers = {
    authorization: `Bearer ${request.access.token}`,
    "idempotency-key": "file-one",
  };
  const malicious = JSON.parse(
    JSON.stringify(input).slice(0, -1) + ',"__proto__":{"extra":"value"}}'
  );
  const malformedHttp = await t.tool(
    request.access.token,
    "POST",
    "/artifacts",
    malicious
  );
  const malformedMcp = await t.request(
    "POST",
    "/api/tools/mcp",
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "record_artifact", arguments: malicious },
    },
    headers
  );
  expect(malformedHttp.status).toBe(422);
  expect(malformedMcp.body.result.structuredContent).toEqual(
    malformedHttp.body
  );
  const registered = await t.request(
    "POST",
    "/api/tools/artifacts",
    input,
    headers
  );
  expect(registered.status).toBe(201);
  expect(registered.body.content).toBe("# 등록 원문\n근거");
  expect(registered.body.file).toMatchObject({
    name: "보고서.md",
    path: "보고서.md",
    mediaType: "text/markdown",
  });
  await writeFile(path.join(workspace.cwd, "보고서.md"), "변경");
  const saved = await t.request(
    "GET",
    `/api/organizations/${org.id}/artifacts/${registered.body.id}`
  );
  expect(saved.body.content).toBe("# 등록 원문\n근거");
  await rm(path.join(workspace.cwd, "보고서.md"));
  const replay = await t.request(
    "POST",
    "/api/tools/mcp",
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "record_artifact", arguments: input },
    },
    headers
  );
  expect(replay.body.result.structuredContent).toEqual(registered.body);
  const other = await t.request(
    "POST",
    "/api/tools/artifacts",
    { ...input, title: "다른 입력" },
    headers
  );
  expect(other.body.error.code).toBe("idempotency_conflict");
  await writeFile(path.join(root, "outside.txt"), "외부 자료");
  await symlink(
    path.join(root, "outside.txt"),
    path.join(workspace.cwd, "link.txt")
  );
  await mkdir(path.join(workspace.cwd, "directory"));
  // #124: 거부 응답만 보고 에이전트가 원인을 가른다. 이유마다 코드가 다르고 고칠 방법을 담은 문장이 붙는다.
  for (const [invalid, code] of [
    ["../outside.txt", "path_outside_folder"],
    [path.join(root, "outside.txt"), "path_outside_folder"],
    ["missing.txt", "file_not_found"],
    ["shared/보고서.md", "file_not_found"],
    ["link.txt", "path_outside_folder"],
    ["directory", "not_regular_file"],
  ] as const) {
    const result = await t.tool(request.access.token, "POST", "/artifacts", {
      ...input,
      path: invalid,
    });
    expect(result.status, invalid).toBe(422);
    expect(result.body.error.code, invalid).toBe(code);
    expect(result.body.error.message, invalid).toEqual(expect.any(String));
  }
  // MCP도 같은 거부를 같은 모양으로 돌려준다.
  const refusedMcp = await t.request(
    "POST",
    "/api/tools/mcp",
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "record_artifact",
        arguments: { ...input, path: "missing.txt" },
      },
    },
    { authorization: `Bearer ${request.access.token}` }
  );
  expect(refusedMcp.body.result.isError).toBe(true);
  expect(refusedMcp.body.result.structuredContent.error.code).toBe(
    "file_not_found"
  );
  // NUL이 든 경로는 파일 시스템에 닿기 전에 입력 계약에서 거부한다.
  expect(
    (
      await t.tool(request.access.token, "POST", "/artifacts", {
        ...input,
        path: "a\u0000b.txt",
      })
    ).body.error.code
  ).toBe("invalid_input");
  // 작업 폴더 안을 가리키는 절대 경로는 받고, 원래 경로는 작업 폴더 기준으로 남긴다.
  await writeFile(path.join(workspace.cwd, "절대.md"), "절대 경로 본문");
  const absolute = await t.tool(request.access.token, "POST", "/artifacts", {
    ...input,
    path: path.join(workspace.cwd, "절대.md"),
  });
  expect(absolute.status).toBe(201);
  expect(absolute.body).toMatchObject({
    content: "절대 경로 본문",
    file: { name: "절대.md", path: "절대.md" },
  });
  await writeFile(
    path.join(workspace.cwd, "data.bin"),
    Buffer.from([0, 255, 1])
  );
  await link(
    path.join(root, "outside.txt"),
    path.join(workspace.cwd, "hardlink.txt")
  );
  const hardlink = await t.tool(request.access.token, "POST", "/artifacts", {
    ...input,
    path: "hardlink.txt",
  });
  expect(hardlink.status).toBe(422);
  expect(hardlink.body.error.code).toBe("hard_link_refused");
  await writeFile(path.join(workspace.cwd, "empty.txt"), "");
  const empty = await t.tool(request.access.token, "POST", "/artifacts", {
    ...input,
    path: "empty.txt",
  });
  expect(empty.body).toMatchObject({
    format: "text",
    content: "",
    file: { size: 0 },
  });
  const binary = await t.tool(request.access.token, "POST", "/artifacts", {
    ...input,
    path: "data.bin",
  });
  expect(binary.body).toMatchObject({
    format: "binary",
    content: "",
    file: { size: 3 },
  });
  const submitted = await t.tool(request.access.token, "POST", "/results", {
    summary: "검증 완료",
    artifactIds: [registered.body.id],
  });
  expect(submitted.status).toBe(201);
  gate.open();
  await t.drain();
  await t.stopServer();
  await rm(path.dirname(workspace.cwd), { recursive: true });
  const restarted = await startServer({
    db: t.db,
    port: 0,
    runtime: agents.runtime,
    dataDir: root,
  });
  try {
    const preserved = await fetch(
      `${restarted.url}/api/organizations/${org.id}/artifacts/${registered.body.id}`
    ).then((r) => r.json());
    expect(artifactSchema.parse(preserved).content).toBe("# 등록 원문\n근거");
    let nextRequest!: RunRequest;
    agents.queue(org.lead.id, (r) => {
      nextRequest = r;
      return idle;
    });
    const message = await fetch(
      `${restarted.url}/api/organizations/${org.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "폴더 다시 준비" }),
      }
    );
    expect(message.status).toBe(201);
    await restarted.drain();
    expect((await stat(nextRequest.workspace!.cwd)).isDirectory()).toBe(true);
    expect((await stat(nextRequest.workspace!.personal!)).isDirectory()).toBe(
      true
    );
  } finally {
    await restarted.close();
  }
});

it("starts and serves other organizations when one organization's folder path is broken, and repairs it on that organization's next run", async () => {
  root = await mkdtemp(path.join(tmpdir(), "artifact-test-"));
  const agents = scriptedAgents();
  t = await startTestServer({ runtime: agents.runtime, dataDir: root });
  const { researching } = serverHelpers(() => t!);
  const broken = await researching(agents, "고장 조직");
  const healthy = await researching(agents, "정상 조직");
  await t.stopServer();

  const brokenShared = path.join(root, "organizations", broken.id, "shared");
  await rm(brokenShared, { recursive: true });
  await writeFile(brokenShared, "폴더 자리에 놓인 파일");

  const restarted = await startServer({
    db: t.db,
    port: 0,
    runtime: agents.runtime,
    dataDir: root,
  });
  const say = async (orgId: string, body: string) => {
    const res = await fetch(
      `${restarted.url}/api/organizations/${orgId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
    expect(res.status).toBe(201);
  };
  const runsOf = async (orgId: string) =>
    runSummaryListSchema.parse(
      await fetch(`${restarted.url}/api/organizations/${orgId}/runs`).then(
        (r) => r.json()
      )
    );
  try {
    let healthyRequest!: RunRequest;
    agents.queue(healthy.lead.id, (r) => {
      healthyRequest = r;
      return idle;
    });
    await say(healthy.id, "정상 조직 실행");
    await restarted.drain();
    expect((await stat(healthyRequest.workspace!.cwd)).isDirectory()).toBe(
      true
    );

    await say(broken.id, "고장 조직 실행");
    await restarted.drain();
    expect((await runsOf(broken.id))[0]?.status).toBe("failed");

    await rm(brokenShared);
    let repairedRequest!: RunRequest;
    agents.queue(broken.lead.id, (r) => {
      repairedRequest = r;
      return idle;
    });
    await say(broken.id, "경로를 고친 뒤 실행");
    await restarted.drain();
    expect((await stat(repairedRequest.workspace!.cwd)).isDirectory()).toBe(
      true
    );
  } finally {
    await restarted.close();
  }
});

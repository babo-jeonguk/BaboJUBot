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
import { artifactSchema, type RunRequest } from "@babojubot/contracts";
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
  for (const invalid of [
    "../outside.txt",
    path.join(root, "outside.txt"),
    "missing.txt",
    "link.txt",
    "directory",
  ]) {
    const result = await t.tool(request.access.token, "POST", "/artifacts", {
      ...input,
      path: invalid,
    });
    expect(result.status, invalid).toBe(422);
  }
  await writeFile(
    path.join(workspace.cwd, "data.bin"),
    Buffer.from([0, 255, 1])
  );
  await link(
    path.join(root, "outside.txt"),
    path.join(workspace.cwd, "hardlink.txt")
  );
  expect(
    (
      await t.tool(request.access.token, "POST", "/artifacts", {
        ...input,
        path: "hardlink.txt",
      })
    ).status
  ).toBe(422);
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
    expect((await stat(workspace.cwd)).isDirectory()).toBe(true);
    expect((await stat(workspace.personal!)).isDirectory()).toBe(true);
    const preserved = await fetch(
      `${restarted.url}/api/organizations/${org.id}/artifacts/${registered.body.id}`
    ).then((r) => r.json());
    expect(artifactSchema.parse(preserved).content).toBe("# 등록 원문\n근거");
  } finally {
    await restarted.close();
  }
});

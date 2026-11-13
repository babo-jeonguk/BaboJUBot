import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./support.ts";

// 빌드한 화면(SPA)을 API 밖의 경로에 낸다. 설치 경로에 점으로 시작하는 폴더(`~/.local`, git worktree의 `.worktrees`)가
// 있어도 화면 주소가 index.html을 받아야 한다.

let t: TestServer | undefined;
let root: string | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it("serves the built dashboard for screen paths even when it is installed under a dot folder", async () => {
  root = await mkdtemp(path.join(tmpdir(), "babojubot-web-dist-"));
  const webDistDir = path.join(root, ".hidden", "dist");
  await mkdir(webDistDir, { recursive: true });
  await writeFile(path.join(webDistDir, "index.html"), "<!doctype html>앱");
  t = await startTestServer({ webDistDir });

  for (const screen of ["/", "/orgs/abc/dashboard"]) {
    const res = await fetch(t.baseUrl + screen);
    expect(res.status, screen).toBe(200);
    expect(await res.text(), screen).toBe("<!doctype html>앱");
  }
  // API 경로는 화면이 아니라 JSON 404다.
  const api = await fetch(t.baseUrl + "/api/nothing");
  expect(api.status).toBe(404);
});

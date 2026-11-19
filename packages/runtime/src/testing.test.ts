import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, onTestFinished } from "vitest";

// 자식의 import에는 파일 주소를 넘긴다. Windows 경로(`C:\\…`)는 ESM import가 받지 않는다.
const testing = new URL("./testing.ts", import.meta.url).href;

// 가짜 HTTP 서버의 처리기가 실패하면 요청한 쪽은 500을 받고, 러너는 잡히지 않은 오류로 그 실패를 받는다(CODING_STANDARDS.md#단언).
// 러너가 받는 것을 보려고 그 서버를 자식 프로그램으로 띄운다. 자식은 응답 상태를 알린 뒤 잡히지 않은 오류로 끝나야 한다.
it("answers a failed fake-server handler with a 500 and reports the failure as an uncaught error", async () => {
  const script = `
    import http from "node:http";
    const { answering } = await import(${JSON.stringify(testing)});
    const server = http.createServer(
      answering(async () => {
        throw new Error("handler broke");
      })
    );
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 실패를 알리지 않아 끝나지 않으면 시험이 끝날 때 끈다.
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = once(child, "exit");
  // 듣기 전에 끝나면(가져오기 실패 등) 기다리지 않고 그 이유로 실패한다.
  const port = await Promise.race([
    once(child.stdout, "data").then(([chunk]) => String(chunk).trim()),
    exited.then(([code]) => {
      throw new Error(
        `fake server exited (${String(code)}) before listening: ${stderr}`
      );
    }),
  ]);
  const response = await fetch(`http://127.0.0.1:${port}/x`);
  const answered = { status: response.status, body: await response.text() };
  const [code] = (await exited) as [number | null];
  expect(answered.status).toBe(500);
  expect(answered.body).toContain("handler broke");
  expect(code).not.toBe(0);
  expect(stderr).toContain("가짜 HTTP 서버가 GET /x을 처리하지 못했다");
  expect(stderr).toContain("handler broke");
});

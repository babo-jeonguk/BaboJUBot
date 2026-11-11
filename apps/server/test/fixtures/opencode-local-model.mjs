// 실제 OpenCode를 이 컴퓨터의 가짜 모델에만 연결해 띄운다(#147). 실제 모델 호출·로그인·모델 목록 다운로드는 없다.
// 사용: node opencode-local-model.mjs <opencode 실행 파일> <가짜 모델 주소(/v1까지)> <opencode 인자...>
// 제품 adapter가 준 설정(OPENCODE_CONFIG_CONTENT: 조직 도구 MCP·권한)은 그대로 두고, 모델 공급자를 가짜 하나로 제한하는 설정만 더한다.
import { spawn } from "node:child_process";

const [program, baseURL, ...args] = process.argv.slice(2);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
config.enabled_providers = ["fixture"];
config.providers = {
  fixture: {
    name: "Local fixture",
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL, apiKey: "synthetic-no-account" },
    models: {
      test: {
        name: "Test",
        type: "chat",
        limit: { context: 128000, output: 1024 },
        capabilities: {
          tools: true,
          input: ["text"],
          output: ["text"],
          reasoning: { supported: false },
          temperature: true,
        },
        cost: { input: 0, output: 0 },
      },
    },
  },
};
const child = spawn(program, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
  },
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
child.on("error", () => process.exit(127));

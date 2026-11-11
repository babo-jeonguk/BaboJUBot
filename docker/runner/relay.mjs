// 격리 실행의 컨테이너 안 시작 프로그램(#149). entry.sh가 신뢰된 PATH·환경으로 부른다.
// 컨테이너에는 네트워크가 없다(--network none). 실행 시도 밖의 중계(packages/runtime/src/providers/relay.ts)가
// /run/babojubot에 읽기로 넣은 파일 소켓만 바깥으로 이어진다. 이 프로그램은 loopback 포트를 그 소켓에 잇기만 하며
// 판정은 하지 않는다. 에이전트가 이 프로그램을 끝내도 자기 통신만 끊긴다.
// - 127.0.0.1:39280 → egress.sock (HTTP 프록시)
// - 127.0.0.1:39281 → tools.sock (조직 도구)
// - BABOJUBOT_INBOUND_PORT가 있으면 inbound.sock에 연결을 미리 붙여 두고, 첫 바이트가 오면 컨테이너 안의 그 포트에 잇는다.
// 포트와 소켓 이름은 packages/runtime/src/providers/container.ts의 relayPorts·relay.ts의 relaySockets와 같아야 한다.
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const directory = "/run/babojubot";
const proxy = "http://127.0.0.1:39280";
const pool = 4;

function forward(port, socketName) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(path.join(directory, socketName));
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

let stopping = false;
function offer(port) {
  if (stopping) return;
  const reverse = net.connect(path.join(directory, "inbound.sock"));
  let used = false;
  reverse.once("data", (first) => {
    used = true;
    reverse.pause();
    offer(port);
    const local = net.connect(port, "127.0.0.1", () => {
      local.write(first);
      reverse.pipe(local).pipe(reverse);
      reverse.resume();
    });
    local.on("error", () => reverse.destroy());
    reverse.on("close", () => local.destroy());
  });
  reverse.on("error", () => reverse.destroy());
  reverse.on("close", () => {
    if (!used) setTimeout(() => offer(port), 200).unref();
  });
}

(async () => {
  const [program, ...args] = process.argv.slice(2);
  if (!program) {
    console.error("babojubot relay: no program");
    process.exit(2);
  }
  await forward(39280, "egress.sock");
  await forward(39281, "tools.sock");
  const inbound = Number(process.env.BABOJUBOT_INBOUND_PORT || 0);
  if (inbound) for (let i = 0; i < pool; i++) offer(inbound);
  const env = { ...process.env };
  delete env.BABOJUBOT_INBOUND_PORT;
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    env[name] = proxy;
    env[name.toLowerCase()] = proxy;
  }
  env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
  // Node 24의 fetch도 프록시 환경을 따르게 한다.
  env.NODE_USE_ENV_PROXY = "1";
  const child = spawn(program, args, { stdio: "inherit", env });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(
      `babojubot relay: ${program} could not start (${error.code})`
    );
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    stopping = true;
    process.exit(code ?? 128 + (os.constants.signals[signal] ?? 1));
  });
})().catch((error) => {
  console.error(`babojubot relay: ${error.code ?? "failed"}`);
  process.exit(70);
});

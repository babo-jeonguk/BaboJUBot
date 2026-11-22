// 감독 실행기(#268)를 이 시스템의 대상으로 저장소 소스에서 빌드한다. checkout 개발자와 CI가 `pnpm --filter @babojubot/process run build`로
// 부른다. Rust 판은 rust-toolchain.toml이 고정하고(rustup이 그 판을 받는다), 의존성은 Cargo.lock 그대로다(--locked).
// 대상은 targets.json이 정한다(실행기를 찾는 supervisor.ts와 같은 표). Linux는 정적 musl이라 그 대상의 표준 라이브러리를 더한다.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const folder = fileURLToPath(new URL(".", import.meta.url));
const targets = JSON.parse(
  readFileSync(new URL("targets.json", import.meta.url), "utf8")
);
const target = targets[`${process.platform} ${process.arch}`];
if (target === undefined) {
  console.error(
    `[supervisor] this system (${process.platform} ${process.arch}) has no supervisor build`
  );
  process.exit(1);
}

/** 한 단계를 이 폴더에서 돌린다(rustup이 rust-toolchain.toml을 찾는 자리). 실패하면 그 단계와 끝남을 남기고 끝낸다. */
function run(command, args) {
  console.log(`[supervisor] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: folder,
    stdio: "inherit",
    timeout: 30 * 60 * 1000,
    killSignal: "SIGKILL",
  });
  if (result.status === 0) return;
  console.error(
    `[supervisor] ${command} ended with ${result.error ? result.error.message : (result.signal ?? `code ${result.status}`)}`
  );
  process.exit(1);
}

if (process.platform === "linux") run("rustup", ["target", "add", target]);
run("cargo", ["build", "--release", "--locked", "--target", target]);

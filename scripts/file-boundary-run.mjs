// 파일 경계 시험(apps/server/vitest.files.config.ts)을 준비한 볼륨 하나에서 돌리고 결과를 file-boundary-reports/에 남긴다.
//   node scripts/file-boundary-run.mjs --volume FAT32 --fs FAT32 --dir F:\files [--case insensitive] [--nfd sensitive]
// --case·--nfd는 준비한 설정이다. 시험이 실제 동작을 관찰해 다르면 실패한다(준비가 틀렸다). 폴더가 없으면 운영체제 임시
// 폴더로 대신하지 않고 실패한다. 결과 모으기는 scripts/file-boundary-report.mjs가 한다.
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const reports = path.join(root, "file-boundary-reports");

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}
const volume = option("volume");
const fileSystem = option("fs");
const dir = option("dir");
if (!volume || !/^[\w.-]+$/.test(volume) || !fileSystem) {
  console.error(
    "usage: --volume <name> --fs <type> --dir <folder> [--case sensitive|insensitive] [--nfd sensitive|insensitive]"
  );
  process.exit(2);
}
mkdirSync(reports, { recursive: true });
const meta = {
  volume,
  fileSystem,
  dir: dir ?? "",
  // 수동 실행은 지정한 commit을 checkout하므로 GITHUB_SHA가 아니라 실제로 받은 commit을 남긴다.
  sha:
    spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).stdout?.trim() || "local",
};
const finish = (fields, code) => {
  writeFileSync(
    path.join(reports, `${volume}.meta.json`),
    JSON.stringify({ ...meta, ...fields }, null, 2)
  );
  process.exit(code);
};

let ready = "";
try {
  if (!dir) ready = "no --dir";
  else if (!statSync(dir).isDirectory()) ready = `${dir} is not a folder`;
} catch (error) {
  ready = `${dir}: ${error.code ?? error}`;
}
if (ready) {
  console.error(`volume ${volume} is not prepared: ${ready}`);
  finish({ exitCode: null, error: `not prepared: ${ready}` }, 1);
}

const expect = {};
const caseSetting = option("case");
if (caseSetting) expect.caseSensitive = caseSetting === "sensitive";
const nfd = option("nfd");
if (nfd) expect.normalizationInsensitive = nfd === "insensitive";
const report = path.join(reports, `${volume}.json`);
const args = [
  "--filter",
  "@babojubot/server",
  "exec",
  "vitest",
  "run",
  "--config",
  "vitest.files.config.ts",
  "--reporter=default",
  "--reporter=json",
  `--outputFile.json=${report}`,
];
const started = Date.now();
const result = spawnSync("pnpm", args, {
  cwd: root,
  stdio: "inherit",
  // Windows의 pnpm은 .cmd라 셸로 띄운다. 인자에는 공백이 없다.
  shell: process.platform === "win32",
  timeout: 15 * 60_000,
  env: {
    ...process.env,
    BABOJUBOT_FILES_TMPDIR: dir,
    BABOJUBOT_FILES_VOLUME: volume,
    BABOJUBOT_FILES_FS: fileSystem,
    BABOJUBOT_FILES_EXPECT: JSON.stringify(expect),
  },
});
const seconds = Math.round((Date.now() - started) / 1000);
const command = `pnpm ${args.join(" ")}`;
if (result.error) {
  console.error(result.error);
  finish({ exitCode: null, seconds, command, error: String(result.error) }, 1);
}
finish(
  { exitCode: result.status, seconds, command, expect },
  result.status ?? 1
);

import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRequest } from "@babojubot/contracts";
import {
  ContainerRefusal,
  dockerRunArgs,
  placeAttempt,
  type ContainerLaunch,
  type ContainerSettings,
} from "./container.ts";
import { createRelayHub } from "./relay.ts";

// 격리 실행의 폴더 권한(#149). 서버가 정한 신원(조직·에이전트)에 맞는 자리만, 링크를 따라가지 않고 확인한 실제 폴더로 넣는다.
// 맞지 않으면 프로바이더를 띄우기 전에 거부한다. 거부 이유에는 이 컴퓨터의 경로를 넣지 않는다.

const org = "00000000-0000-4000-8000-00000000000a";
const otherOrg = "00000000-0000-4000-8000-0000000000ff";
const agent = "00000000-0000-4000-8000-00000000000b";
const peer = "00000000-0000-4000-8000-00000000000c";
const identity = {
  organizationId: org,
  agentId: agent,
  runId: "00000000-0000-4000-8000-00000000000d",
};
const settings: ContainerSettings = {
  docker: ["docker"],
  image: "babojubot-runner",
  owner: "test",
  relay: createRelayHub(),
};

let root: string;
let data: string;
let home: string;
let login: string;
const attempts: string[] = [];

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "babojubot-mounts-"))
  );
  data = path.join(root, "data");
  for (const id of [org, otherOrg]) {
    await mkdir(path.join(data, "organizations", id, "shared"), {
      recursive: true,
    });
    for (const a of [agent, peer])
      await mkdir(path.join(data, "organizations", id, "agents", a), {
        recursive: true,
      });
  }
  home = path.join(data, "providers", "claude", "organizations", org);
  login = path.join(data, "providers", "claude", "login");
  await mkdir(home, { recursive: true });
  await mkdir(login, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await Promise.all(
    attempts.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

const workspace = (
  organizationId = org,
  base = data
): NonNullable<RunRequest["workspace"]> => ({
  cwd: path.join(base, "organizations", organizationId, "shared"),
  organization: path.join(base, "organizations", organizationId, "shared"),
  personal: path.join(base, "organizations", organizationId, "agents", agent),
  peers: [
    {
      agentId: peer,
      path: path.join(base, "organizations", organizationId, "agents", peer),
      access: "read",
    },
  ],
});

function launch(
  options: {
    workspace?: RunRequest["workspace"];
    home?: string;
    cwd?: string;
    attempt?: string;
    files?: { source: string; target: string }[];
  } = {}
): ContainerLaunch {
  const ws = "workspace" in options ? options.workspace : workspace();
  const placement = placeAttempt(settings, options.home ?? home, {
    execution: "container",
    workspace: ws,
    identity,
  });
  return placement!.container!({
    cwd: options.cwd ?? ws?.cwd ?? home,
    program: "claude",
    ...(options.attempt ? { attempt: options.attempt } : {}),
    ...(options.files ? { files: options.files } : {}),
  });
}

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContainerRefusal);
    expect((error as Error).message).not.toContain(root);
    return (error as ContainerRefusal).code;
  }
  throw new Error("expected a refusal");
};

async function attemptDir() {
  // 임시 폴더가 링크 뒤에 있어도(macOS) mount 원본과 같도록 실제 경로로 받는다.
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "babojubot-attempt-"))
  );
  attempts.push(dir);
  return dir;
}

// Windows는 Docker 격리를 지원하지 않는다(docs/providers.md 격리 실행).
describe.skipIf(process.platform === "win32")("container mount grants", () => {
  it("mounts the organization folder and own folder writable, peers read-only and the product folder, nothing else", () => {
    // 연결의 로그인 원본 폴더는 제품 폴더 옆에 있어도 넣지 않는다(#148).
    const { mounts } = launch();
    const base = path.join(data, "organizations", org);
    expect(
      mounts
        .map(({ path: target, writable }) => ({ target, writable }))
        .sort((a, b) => a.target.localeCompare(b.target))
    ).toEqual(
      [
        { target: path.join(base, "agents", agent), writable: true },
        { target: path.join(base, "agents", peer), writable: false },
        { target: path.join(base, "shared"), writable: true },
        { target: home, writable: true },
      ].sort((a, b) => a.target.localeCompare(b.target))
    );
    expect(mounts.map((mount) => mount.source)).not.toContain(login);
  });

  it("refuses a pre-planted link in place of a mount source or one of its folders", async () => {
    const shared = path.join(data, "organizations", org, "shared");
    await rm(shared, { recursive: true });
    await symlink(path.join(data, "organizations", otherOrg, "shared"), shared);
    expect(refusal(() => launch())).toBe("mount_link");

    await rm(shared);
    await mkdir(shared);
    const personal = path.join(data, "organizations", org, "agents", agent);
    await rm(personal, { recursive: true });
    await symlink(root, personal);
    expect(refusal(() => launch())).toBe("mount_link");
  });

  it("refuses when the organization's own folder is replaced by a link to another organization", async () => {
    const own = path.join(data, "organizations", org);
    await rm(own, { recursive: true });
    await symlink(path.join(data, "organizations", otherOrg), own);
    expect(refusal(() => launch())).toBe("mount_link");
  });

  it("refuses folders of another organization, another agent's folder as its own, or itself as a peer", () => {
    expect(refusal(() => launch({ workspace: workspace(otherOrg) }))).toBe(
      "mount_outside"
    );
    const swapped = workspace();
    swapped.personal = path.join(data, "organizations", org, "agents", peer);
    expect(refusal(() => launch({ workspace: swapped }))).toBe("mount_outside");
    const self = workspace();
    self.peers = [
      ...(self.peers ?? []),
      { agentId: agent, path: self.personal!, access: "read" },
    ];
    expect(refusal(() => launch({ workspace: self }))).toBe("mount_overlap");
  });

  it("refuses a product folder outside its slot, such as the user's home or a socket folder", () => {
    expect(refusal(() => launch({ home: root }))).toBe("mount_outside");
    expect(refusal(() => launch({ home: "/var/run" }))).toBe("mount_outside");
  });

  it("does not add a working folder that no granted folder contains", () => {
    expect(
      refusal(() =>
        launch({ cwd: path.join(data, "organizations", otherOrg, "shared") })
      )
    ).toBe("cwd_outside");
  });

  it("refuses missing folders and files where folders belong", async () => {
    const personal = path.join(data, "organizations", org, "agents", agent);
    await rm(personal, { recursive: true });
    expect(refusal(() => launch())).toBe("mount_missing");
    await writeFile(personal, "not a folder");
    expect(refusal(() => launch())).toBe("mount_type");
  });

  it("accepts only private attempt folders and plain files inside them", async () => {
    const attempt = await attemptDir();
    await writeFile(path.join(attempt, "mcp.json"), "{}");
    const ok = launch({
      attempt,
      files: [
        {
          source: path.join(attempt, "mcp.json"),
          target: path.join(workspace().cwd, ".agents", "mcp.json"),
        },
      ],
    });
    expect(ok.mounts.some((m) => m.path === attempt && !m.writable)).toBe(true);

    await chmod(attempt, 0o755);
    expect(refusal(() => launch({ attempt }))).toBe("mount_attempt");
    await chmod(attempt, 0o700);
    expect(refusal(() => launch({ attempt: root }))).toBe("mount_attempt");

    await symlink("/etc/passwd", path.join(attempt, "link.json"));
    expect(
      refusal(() =>
        launch({
          files: [
            {
              source: path.join(attempt, "link.json"),
              target: path.join(workspace().cwd, "x.json"),
            },
          ],
        })
      )
    ).toBe("mount_link");
  });

  it("follows links above the data folder (server-owned) and mounts the real folder at the path the program uses", async () => {
    const alias = path.join(root, "alias");
    await symlink(data, alias);
    const { mounts } = launch({
      workspace: workspace(org, alias),
      home: path.join(alias, "providers", "claude", "organizations", org),
    });
    const shared = mounts.find(
      (m) => m.path === path.join(alias, "organizations", org, "shared")
    );
    expect(shared?.source).toBe(
      path.join(data, "organizations", org, "shared")
    );
  });
});

describe.skipIf(process.platform === "win32")(
  "a data folder behind a link",
  () => {
    it("accepts a working folder opened by its real path and an attempt file placed there (Antigravity)", async () => {
      const alias = path.join(root, "alias");
      await symlink(data, alias);
      const attempt = await attemptDir();
      await writeFile(path.join(attempt, "mcp_config.json"), "{}");
      const real = path.join(data, "organizations", org, "shared");
      const { mounts } = launch({
        workspace: workspace(org, alias),
        home: path.join(alias, "providers", "claude", "organizations", org),
        cwd: real,
        files: [
          {
            source: path.join(attempt, "mcp_config.json"),
            target: path.join(real, ".agents", "mcp_config.json"),
          },
        ],
      });
      expect(mounts).toContainEqual({
        source: real,
        path: real,
        writable: true,
      });
      expect(mounts).toContainEqual({
        source: path.join(attempt, "mcp_config.json"),
        path: path.join(real, ".agents", "mcp_config.json"),
        writable: false,
      });
    });
  }
);

describe.skipIf(process.platform === "win32")(
  "session maintenance (Claude pre-compaction) mounts",
  () => {
    const maintain = (cwd: string) =>
      placeAttempt(settings, home, {
        execution: "container",
        organizationId: org,
      })!.container!({ cwd, program: "claude" });

    it("mounts the product folder and the organization's own folder read-only as the working folder", () => {
      const shared = path.join(data, "organizations", org, "shared");
      expect(
        maintain(shared).mounts.map(({ path: target, writable }) => ({
          target,
          writable,
        }))
      ).toEqual([
        { target: home, writable: true },
        { target: shared, writable: false },
      ]);
    });

    it("refuses a stored working folder of another organization", () => {
      expect(
        refusal(() =>
          maintain(path.join(data, "organizations", otherOrg, "shared"))
        )
      ).toBe("mount_outside");
    });
  }
);

describe.skipIf(process.platform === "win32")("container command", () => {
  const args = (env: NodeJS.ProcessEnv = {}) =>
    dockerRunArgs(launch(), {
      name: "babojubot-x",
      cwd: workspace().cwd,
      env,
      args: ["-p", "hi"],
      relay: "/tmp/babojubot-relay-x",
    });

  it("starts with no network, only the relay folder, and no published ports or host aliases", () => {
    const value = args();
    expect(
      value.slice(value.indexOf("--network"), value.indexOf("--network") + 2)
    ).toEqual(["--network", "none"]);
    expect(value).not.toContain("--publish");
    expect(value).not.toContain("--add-host");
    expect(value).toContain(
      "type=bind,source=/tmp/babojubot-relay-x,target=/run/babojubot,readonly"
    );
  });

  it("does not activate a shared environment or pass loader settings into the container", () => {
    const value = args({
      LD_PRELOAD: "/x.so",
      NODE_OPTIONS: "--require /x.js",
      PYTHONPATH: "/x",
      BASH_ENV: "/x",
      HOME: home,
    });
    expect(value.join(" ")).not.toMatch(
      /BABOJUBOT_VENV|LD_PRELOAD|NODE_OPTIONS|PYTHONPATH|BASH_ENV/
    );
    expect(value).toContain("HOME");
    expect(value).toContain("BABOJUBOT_PERSONAL");
  });
});

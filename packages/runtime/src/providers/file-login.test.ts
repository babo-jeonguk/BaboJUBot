import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileLogin, type FileLoginShape } from "./file-login.ts";
import { readRegularFile } from "./regular-file.ts";
import { testFolders } from "./test-folders.ts";

const folders = testFolders();
const windows = process.platform === "win32";
const organizationId = "0b7f3c1e-0000-4000-8000-000000000002";

/** 로그인 자리가 조직 폴더 안 폴더 두 칸 아래에 있는 연결(Antigravity와 같은 모양). */
const nested: FileLoginShape = {
  label: "Nested",
  loginFile: path.join(".gemini", "antigravity-cli", "token"),
  contents: (token) => JSON.stringify({ token }),
  isStandIn: async (file) => {
    const text = await readRegularFile(file);
    return text !== undefined && text === JSON.stringify({ token: "" });
  },
};

// 조직 제품 폴더는 그 조직의 모든 컨테이너에 쓰기로 들어간다. 다른 실행 시도의 컨테이너가 로그인 자리로 가는 폴더를
// 연결의 로그인 전용 폴더를 가리키는 링크로 바꿔도, 서버가 자리 표시를 두면서 그 링크를 따라가 원본 로그인을 지우거나
// 덮어쓰면 안 된다. 검사(prepare)와 자리 표시(attemptLogin) 사이에 링크를 넣어 그 순서를 만든다.
describe("placing the login stand-in in a folder an isolated agent can write", () => {
  // Windows에서 링크를 만들려면 관리자 권한이나 개발자 모드가 필요하다. 링크 경우는 POSIX에서 본다.
  it.skipIf(windows)(
    "does not follow a folder link to the connection's own login",
    async () => {
      const root = await folders.make("babojubot-file-login-");
      const login = fileLogin(root, "nested", nested);
      const original = path.join(root, "providers", "nested", "login", "token");
      await mkdir(path.dirname(original), { recursive: true });
      await writeFile(original, "REAL LOGIN");

      const prepared = await login.prepare(organizationId, true);
      if (prepared.refusal !== undefined || !prepared.attemptLogin)
        throw new Error(`no isolated login: ${prepared.refusal}`);
      const organization = path.join(
        root,
        "providers",
        "nested",
        "organizations",
        organizationId
      );
      await mkdir(path.join(organization, ".gemini"), { recursive: true });
      // 조직 폴더 기준 상대 링크: .gemini/antigravity-cli → providers/nested/login
      await symlink(
        path.join("..", "..", "..", "login"),
        path.join(organization, ".gemini", "antigravity-cli")
      );
      const attempt = await folders.make("babojubot-attempt-");

      await expect(prepared.attemptLogin(attempt, "grant")).rejects.toThrow();
      expect(await readFile(original, "utf8")).toBe("REAL LOGIN");
    }
  );

  it("places the stand-in in the organization's own folders", async () => {
    const root = await folders.make("babojubot-file-login-");
    const login = fileLogin(root, "nested", nested);
    const prepared = await login.prepare(organizationId, true);
    if (prepared.refusal !== undefined || !prepared.attemptLogin)
      throw new Error(`no isolated login: ${prepared.refusal}`);
    const attempt = await folders.make("babojubot-attempt-");

    const placed = await prepared.attemptLogin(attempt, "grant");
    expect(await readFile(placed.source, "utf8")).toBe(
      JSON.stringify({ token: "grant" })
    );
    expect(await readFile(placed.target, "utf8")).toBe(
      JSON.stringify({ token: "" })
    );
  });

  // 격리 실행의 컨테이너가 심어 둔 링크는 격리를 끈 뒤에도 남는다. 이 컴퓨터의 실행이 조직 자리에 링크를 만들며 그 링크를 따라가면
  // 연결의 원본 로그인을 set-aside로 옮기거나 지운다.
  it.skipIf(windows)(
    "does not follow a folder link an isolated run left when a host run links the login",
    async () => {
      const root = await folders.make("babojubot-file-login-");
      const login = fileLogin(root, "nested", nested);
      const original = path.join(root, "providers", "nested", "login", "token");
      await mkdir(path.dirname(original), { recursive: true });
      await writeFile(original, "REAL LOGIN");
      const organization = path.join(
        root,
        "providers",
        "nested",
        "organizations",
        organizationId
      );
      await mkdir(path.join(organization, ".gemini"), { recursive: true });
      await symlink(
        path.join("..", "..", "..", "login"),
        path.join(organization, ".gemini", "antigravity-cli")
      );

      await expect(login.prepare(organizationId, false)).rejects.toThrow(
        /not a folder/
      );
      expect(await readFile(original, "utf8")).toBe("REAL LOGIN");
    }
  );
});

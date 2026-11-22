import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { credentialResidue, residueRefusal } from "./credential-relay.ts";
import { connectionFolders } from "./folders.ts";
import { loginLink, readLogin } from "./login-link.ts";
import { inFolder } from "./pinned-folder.ts";

/**
 * 로그인을 파일로 같이 쓰는 연결(Codex·Antigravity)마다 다른 것. 나머지 준비 순서는 `fileLogin`이 맡는다(#146).
 * Claude(중계가 환경 변수로 붙이는 setup-token)와 OpenCode(조직 DB로 옮기는 로그인)는 여기에 넣지 않는다.
 */
export type FileLoginShape = {
  /** 경고 문구에 쓰는 연결 이름. */
  label: string;
  /** 제품 폴더 안 로그인 파일 자리(상대 경로). 원본은 연결의 로그인 전용 폴더에 같은 파일 이름으로 둔다. */
  loginFile: string;
  /** 실행 시도의 권한을 담은 로그인 파일 내용. 권한이 빈 것은 조직 폴더에 두는 자리 표시다. */
  contents: (token: string) => string;
  /** 이 어댑터가 둔 파일(자리 표시나 실행 시도 전용 로그인)인가. 연결마다 알아보는 방법이 다르다. */
  isStandIn: (file: string) => Promise<boolean>;
};

/** 격리 실행의 실행 시도 전용 로그인 파일: 이 컴퓨터의 원본 위치와 컨테이너 안 자리. */
export type AttemptLoginFile = { source: string; target: string };

/** 실행 시도 하나의 로그인 준비 결과. */
export type PreparedLogin =
  /** 조직 제품 폴더에 로그인 흔적이 남아 격리 실행을 시작하지 않는다. */
  | { refusal: string }
  | {
      refusal?: undefined;
      /** 실행이 돌 제품 폴더. */
      home: string;
      /**
       * 격리 실행에만 있다. 실행 시도 전용 폴더 `attempt`(부른 쪽이 만들고 지운다)에 권한 `token`을 담은 로그인 파일을 쓰고,
       * 조직 폴더의 로그인 자리에 권한 없는 자리 표시를 둔다. 돌려준 파일을 그 컨테이너에만 읽기로 넣는다.
       */
      attemptLogin?: (
        attempt: string,
        token: string
      ) => Promise<AttemptLoginFile>;
    };

/**
 * 연결의 로그인 하나를 모든 조직이 같이 쓰게 하고, 실행 시도마다 돌 제품 폴더를 정한다(#146).
 *
 * 준비 순서: 조직 ID 확인(로그인 파일을 바꾸기 전) → 연결 자리 로그인 준비 → 격리 실행이면 흔적 검사, 격리를 끈 실행이면
 * 자리 표시 지우기와 조직 자리 링크 → 돌 제품 폴더 → (격리 실행) 실행 시도 전용 로그인 파일·자리 표시.
 *
 * - 격리 실행은 링크를 만들지 않고, 링크를 만들 수 있든 없든 조직 제품 폴더로 돈다. 원본·로그인 전용 폴더·연결 폴더는
 *   컨테이너에 넣지 않는다(#148). 원본을 가리키는 알려진 링크와 이 어댑터의 자리 표시 말고 조직 자리에 남은 것은 흔적이다.
 * - 격리를 끈 실행은 링크를 만들 수 있으면 조직 제품 폴더, 없으면 연결 폴더로 돈다. 격리 실행이 남긴 자리 표시는 로그인이
 *   아니므로 먼저 지우고, 조직 자리의 보통 파일은 `loginLink`가 연결 폴더 `set-aside/`로 옮긴다.
 *
 * 권한의 발급·회수, 실행 시도 전용 폴더의 생성·삭제, 배치·프로세스 수명은 부른 어댑터가 맡는다. 링크를 만든 것은 로그인이
 * 맞다는 뜻이 아니다. 로그인 판정은 프로그램의 응답으로 한다.
 */
export function fileLogin(
  dataDir: string,
  connectionId: string,
  shape: FileLoginShape
) {
  const folders = connectionFolders(dataDir, connectionId);
  const home = folders.connection;
  /** 연결의 로그인 원본. 컨테이너에는 넣지 않는다(#148). */
  const original = path.join(home, "login", path.basename(shape.loginFile));
  /** 제품 폴더 안 로그인 자리의 폴더 칸과 마지막 이름. 확인한 폴더를 거쳐 내려가는 데 쓴다. */
  const loginFolder = path.dirname(shape.loginFile);
  const loginParts = loginFolder === "." ? [] : loginFolder.split(path.sep);
  const loginName = path.basename(shape.loginFile);
  const loginFileIn = (productHome: string) =>
    path.join(productHome, shape.loginFile);
  const share = loginLink({
    original,
    fallback: loginFileIn(home),
    label: shape.label,
    setAside: path.join(home, "set-aside"),
  });
  /** 연결 폴더도 조직 폴더와 같은 링크로 로그인을 읽는다. 로그인 명령·준비 확인·모델 목록·갱신이 조직 실행과 같은 로그인을 본다. */
  const prepareConnection = async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await share(loginFileIn(home));
  };
  /**
   * 조직 폴더의 로그인 자리에 권한 없는 자리 표시를 둔다. 실행 시도마다 그 위에 자기 로그인 파일을 넣는 자리다(Docker는 넣을 자리가 있어야 한다).
   * 자리로 가는 폴더 칸은 확인한 폴더의 handle을 거쳐 내려가므로, 다른 실행 시도의 컨테이너가 그 칸을 링크로 바꿔도 그 너머를 쓰지 않는다.
   * 원본을 가리키는 링크는 따라가 쓰지 않도록 먼저 지운다. 같은 조직의 다른 실행 시도가 함께 두어도 같은 내용이다.
   */
  const placePlaceholder = async (organization: string) => {
    const placed = await inFolder(
      organization,
      loginParts,
      async (folder) => {
        const loginAt = folder.at(loginName);
        if (await shape.isStandIn(loginAt)) return;
        await rm(loginAt, { force: true });
        try {
          await writeFile(loginAt, shape.contents(""), {
            mode: 0o600,
            flag: "wx",
          });
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "EEXIST" ||
            !(await shape.isStandIn(loginAt))
          )
            throw error;
        }
      },
      { create: true }
    );
    if (!placed.reached)
      throw new Error(
        "the login place in the organization folder is not a folder; the stand-in was not placed"
      );
  };
  /** 조직 폴더의 로그인 자리에 이 어댑터가 둔 자리 표시가 있는가. 폴더 칸이 링크 등이면 확인할 수 없으므로 아니다. */
  const standIn = async (organization: string) => {
    const checked = await inFolder(organization, loginParts, (folder) =>
      shape.isStandIn(folder.at(loginName))
    );
    return checked.reached ? checked.value : false;
  };
  const prepare = async (
    organizationId: string,
    isolated: boolean
  ): Promise<PreparedLogin> => {
    // 잘못된 조직 ID면 여기서 던진다. 로그인 파일은 아직 건드리지 않았다.
    const organization = folders.organization(organizationId);
    await prepareConnection();
    const loginAt = loginFileIn(organization);
    if (isolated) {
      if (
        (await credentialResidue(organization, [shape.loginFile], original)) &&
        !(await standIn(organization))
      )
        return { refusal: residueRefusal };
      await mkdir(organization, { recursive: true, mode: 0o700 });
      return {
        home: organization,
        async attemptLogin(attempt, token) {
          // 조직 폴더는 그 조직의 모든 컨테이너에 쓰기로 들어간다. 권한이 든 로그인 파일은 실행 시도 전용 폴더에 두고,
          // 그 컨테이너에만 조직 폴더의 로그인 자리 위에 읽기로 넣는다. 조직 폴더에는 권한 없는 자리 표시만 둔다.
          const source = path.join(attempt, path.basename(shape.loginFile));
          await writeFile(source, shape.contents(token), {
            mode: 0o600,
            flag: "wx",
          });
          await placePlaceholder(organization);
          return { source, target: loginAt };
        },
      };
    }
    // 이 컴퓨터의 실행도 확인한 폴더를 거쳐 내려간다. 격리 실행이 남긴 폴더 링크는 격리를 끈 뒤에도 남아 있다.
    await mkdir(organization, { recursive: true, mode: 0o700 });
    const placed = await inFolder(
      organization,
      loginParts,
      async (folder) => {
        const at = folder.at(loginName);
        if (await shape.isStandIn(at)) await rm(at, { force: true });
        return share(at);
      },
      { create: true }
    );
    if (!placed.reached)
      throw new Error(
        "the login place in the organization folder is not a folder; the run was not started"
      );
    const linked = placed.value;
    const productHome = linked ? organization : home;
    await mkdir(productHome, { recursive: true, mode: 0o700 });
    return { home: productHome };
  };
  /**
   * 이 컴퓨터의 실행·로그인 명령·갱신이 지금 읽는 연결의 로그인(#209). 인증 중계가 쓴다. 링크를 만들 수 없는 컴퓨터에서는 원본이
   * 연결 폴더 자리에 있으므로 그 자리를 읽는다. 복사본은 만들지 않는다.
   */
  const read = () => readLogin(original, loginFileIn(home));
  return { home, original, loginFileIn, prepareConnection, prepare, read };
}

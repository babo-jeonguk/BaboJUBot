import { rm } from "node:fs/promises";
import path from "node:path";
import { attemptEach, failureCode } from "@babojubot/contracts/failure";
import { inFolder } from "@babojubot/files";
import { removeFolder } from "@babojubot/process/remove-folder";

/** 실행 시도 폴더를 쓰는 프로그램. 지우기 전에 끝내고(`end`), 그 끝(`done`)을 기다린다. */
type Program = {
  end(): void;
  done: Promise<{ ended: boolean; causes: readonly string[] }>;
};
/** 진단에 적을 폴더의 종류와 실행 시도. */
type About = {
  kind: "attempt folder" | "log folder";
  connection: string;
  runId?: string;
};

/**
 * 실행 시도가 만든 폴더 하나(실행 시도 폴더, Antigravity 기록 폴더)와 그 정리. 만든 직후 감싼다.
 * - 제품이 이 폴더에 자격 증명 사본(로그인 파일, 조직 도구 토큰이 든 설정)을 쓸 때는 쓰기 전에 `credential`로 그 이름을 받아 쓴다.
 *   남길 때 지울 목록은 이 기록 하나다(이름 모양으로 찾지 않는다).
 * - 이 폴더를 쓰는 프로그램은 띄운 직후 `usedBy`로 맡긴다.
 * - `remove`는 맡은 프로그램을 끝내고 그 끝을 기다린 뒤, 모두 끝을 확인했으면(`done.ended`: 트리와 컨테이너의 끝) 폴더를 지운다.
 *   하나라도 끝을 확인하지 못했으면 그 프로그램이 아직 폴더를 쓸 수 있으므로 폴더는 남기고 기록한 자격 증명 사본만 지운 뒤, 폴더 위치와
 *   그 실행 시도가 남긴 실패 코드(`done.causes`)를 경고로 남긴다. 시작 실패·입력 실패처럼 끝을 확인한 실행 시도는 폴더를 지운다. 남은 폴더를 거두는 곳은 아직 없다. 자격 증명 사본을 지우지 못하면 그 실패도 경고에 담는다. 실행 결과는 바꾸지 않는다.
 * 폴더는 이 사용자만 접근하는 곳에 만들지만, 이 컴퓨터에서 도는 프로그램은 같은 사용자라 그 안을 바꿀 수 있다. 그래서 자격 증명
 * 사본은 확인한 폴더를 거쳐 그 이름을 지운다(`inFolder`, CODING_STANDARDS 「제품 코드」).
 */
export function attemptFolder(folder: string, about: About) {
  const credentials: string[] = [];
  const programs: Program[] = [];
  /** 기록한 자격 증명 사본을 지운다. 그 실패의 코드를 돌려준다. */
  const removeCredentials = async () =>
    (
      await attemptEach(
        credentials.map((name) => async () => {
          const removed = await inFolder(folder, [], (inside) =>
            rm(inside.at(name), { force: true })
          );
          if (removed.state === "unverifiable")
            throw Object.assign(
              new Error(`the attempt folder could not be checked`),
              { code: `folder_${removed.found}` }
            );
        })
      )
    ).map(failureCode);
  return {
    path: folder,
    /** 제품이 이 폴더에 쓸 자격 증명 사본의 이름(폴더 바로 아래 한 칸). 쓰기 전에 기록하고 그 경로를 돌려준다. */
    credential(name: string) {
      if (path.basename(name) !== name)
        throw new Error(`a credential copy is one name in the folder: ${name}`);
      credentials.push(name);
      return path.join(folder, name);
    },
    /** 이 폴더를 쓰는 프로그램. `remove`가 끝내고 그 끝을 기다린다. */
    usedBy<T extends Program>(program: T): T {
      programs.push(program);
      return program;
    },
    async remove(): Promise<void> {
      for (const program of programs) program.end();
      const ended = await Promise.all(programs.map((program) => program.done));
      const causes = ended.flatMap((end) => (end.ended ? [] : end.causes));
      if (ended.every((end) => end.ended)) {
        await removeWhole(folder, about);
        return;
      }
      const failed = await removeCredentials();
      const copies =
        credentials.length === 0
          ? ""
          : failed.length === 0
            ? " without the credential copies put in it"
            : `; the credential copies put in it could not all be removed (${failed.join(", ")})`;
      console.warn(
        `[provider] the programs of run ${about.runId ?? "(none)"} on connection ${about.connection} were not confirmed ended (${causes.join(", ")}); its ${about.kind} is kept at ${folder}${copies}`
      );
    },
  };
}
export type AttemptFolder = ReturnType<typeof attemptFolder>;

/**
 * 폴더를 지운다. 지우기는 `removeFolder`가 하므로 잠깐 잠긴 오류는 정해진 횟수만큼 다시 시도한다.
 * 그래도 지우지 못하면 폴더는 그대로 두고 이 경고가 기록이 된다(자동으로 거두는 곳은 없고, 그 폴더가 쥐고 있던 토큰은 이미 무효다).
 */
async function removeWhole(folder: string, about: About): Promise<void> {
  try {
    await removeFolder(folder);
  } catch (error) {
    console.warn(
      `[provider] could not remove the ${about.kind} of run ${about.runId ?? "(none)"} on connection ${about.connection}; it is left at ${folder} (${failureCode(error)})`
    );
  }
}

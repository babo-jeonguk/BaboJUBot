// 스크립트가 끝나기 전에 출력이 다 닿게 하는 한 곳. 파이프로 이어진 표준 출력·오류의 쓰기는 POSIX에서 비동기라, 출력한 뒤 바로
// process.exit()하면 아직 쓰지 못한 출력이 버려진다(Node 문서 process `A note on process I/O`·`process.exit()`). 끝까지 흘러가 끝나는
// 스크립트는 process.exitCode를 두고, 중간에 멈춰야 하는 자리(사용법 오류 등)는 `process.exit(await afterOutput(code))`로 끝낸다.
// 비상 종료(두 번째 Ctrl-C, 자기 시한을 지키는 강제 종료)는 출력을 기다리지 않고 바로 process.exit한다: 아무도 읽지 않는 파이프면
// 출력이 영영 닿지 않는다(scripts/live/chaos-interrupt.ts, scripts/boot-check.mjs).
import { isDisconnect } from "@babojubot/contracts";

/**
 * 스트림에 넘긴 쓰기가 모두 끝나면 true, 쓰기가 실패했으면 false. 빈 쓰기의 콜백은 앞선 쓰기가 끝난 뒤에 온다. 기다리는 동안
 * 스트림의 오류 이벤트 중 읽는 쪽이 닫혀 난 것(EPIPE 등, isDisconnect)도 "쓰지 못함"으로 받는다: 받지 않으면 처리되지 않은 오류가
 * 프로세스를 먼저 끝내 부른 쪽이 정한 종료 코드를 잃는다.
 */
function drained(stream: NodeJS.WriteStream) {
  return new Promise<boolean>((resolve) => {
    // 떼지 않는다: 빈 쓰기의 콜백이 앞선 쓰기의 오류 이벤트보다 먼저 올 수 있고, 이 도움 뒤에는 끝내기만 남는다.
    stream.on("error", (error) => {
      // 읽는 쪽이 닫혀 난 오류(EPIPE 등)만 "쓰지 못함"이다. 그 밖의 오류는 드러낸다.
      if (!isDisconnect(error)) throw error;
      resolve(false);
    });
    stream.write("", (error) => resolve(!error));
  });
}

/**
 * 표준 출력·오류에 넘긴 출력이 모두 닿으면 끝낼 코드를 돌려준다. 출력을 다 쓰지 못했으면 성공 코드(0) 대신 1이다.
 * 부르는 쪽은 `process.exit(await afterOutput(code))`로 끝낸다.
 */
export async function afterOutput(code: number): Promise<number> {
  const written = await Promise.all([
    drained(process.stdout),
    drained(process.stderr),
  ]);
  return written.every(Boolean) || code !== 0 ? code : 1;
}

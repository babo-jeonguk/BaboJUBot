import { expect, type Locator, type Page } from "@playwright/test";
import { pageLoad } from "./live-events.ts";

// 레이아웃 값(위치, 크기, 선 경로, scrollWidth)은 보인 직후 최종이 아니다. 한눈에 맞추기(`fitView`)와 React Flow의 이름표
// 자리는 다음 frame에 잡히고, 지도 배치는 따로 오는 지도 질의를 다시 받은 뒤 바뀌며, 좁은 화면 배치는 media query가 바뀐
// 다음 그리기에서 바뀐다. 한 번만 읽으면 서로 다른 배치에서 잰 값을 비교한다(CODING_STANDARDS.md#화면).

export type Box = { x: number; y: number; width: number; height: number };

/**
 * `read`를 연달아 두 번 읽은 값이 같아질 때까지 다시 읽고 그 값을 돌려준다. `read`가 `undefined`를 돌려주면(아직 그려지지
 * 않음) 같은 값으로 치지 않는다. 기본 상한은 화면 첫 배치의 상한(`pageLoad`)이다. 부하가 큰 기기에서 기본 5초를 넘겼다(#215).
 */
export async function settled<T>(
  read: () => Promise<T | undefined>,
  { timeout = pageLoad.timeout }: { timeout?: number } = {}
): Promise<T> {
  let value: T | undefined;
  let last: string | undefined;
  await expect
    .poll(
      async () => {
        value = await read();
        const now = value === undefined ? undefined : JSON.stringify(value);
        const same = now !== undefined && now === last;
        last = now;
        return same;
      },
      { timeout, message: "the layout did not settle" }
    )
    .toBe(true);
  return value!;
}

/** 넘긴 요소들의 위치·크기를 자리 잡을 때까지 다시 재어 돌려준다. 상자마다 따로 잴 때와 달리 한 배치에서 잰 값이다. */
export async function settledBoxes<L extends Locator[]>(
  locators: [...L],
  options?: { timeout?: number }
) {
  const boxes = await settled(async () => {
    const all = await Promise.all(locators.map((l) => l.boundingBox()));
    return all.every((box) => box !== null) ? (all as Box[]) : undefined;
  }, options);
  return boxes as { [K in keyof L]: Box };
}

/** 화면이 옆으로 넘치지 않을 때까지 다시 확인한다. 막 보인 화면은 내용이 다 들어오기 전이라 한 번 읽은 값이 최종이 아니다. */
export async function expectNoHorizontalOverflow(page: Page, message?: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        ),
      { message }
    )
    .toBe(true);
}

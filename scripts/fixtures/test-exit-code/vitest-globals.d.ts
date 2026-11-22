// scripts/check-test-exit-code.mjs가 이 폴더의 시험을 vitest `--globals`로 돌려 `it`을 전역으로 넣는다. 이 폴더에서는 vitest를 가져올 수
// 없어(저장소 뿌리는 vitest에 기대지 않는다) 그 전역의 모양만 적는다.
declare function it(name: string, test: () => void): void;

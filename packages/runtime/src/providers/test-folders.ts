import { failureCode, type RuntimeAdapter } from "@babojubot/contracts";
import type { LaunchedTree } from "@babojubot/process";
import { testFolders as processFolders } from "@babojubot/process/testing";

/** 경계 대역이 보는 트리의 면: 실제 끄기만 쓴다. */
type StoppableTree = Pick<LaunchedTree, "stop">;
/**
 * 공용 실행 경계 대역이 띄운 트리를 넘기는 곳. 대역을 건 시험 파일에서 만든 `testFolders` 하나가 맡는다. 그런 파일에서 둘째
 * `testFolders`를 만들면 던진다(어느 폴더 정리가 트리를 맡는지 모르게 되므로, 아는 모양 하나만 받는다). 모듈 상태는 시험 파일마다
 * 따로다(vitest가 파일마다 모듈을 새로 읽는다).
 */
let treeOwner: (<T extends StoppableTree>(tree: T) => T) | undefined;
/** 이 시험 파일에 공용 실행 경계 대역(`owningLaunchTree`)이 걸렸는가. */
let boundary = false;

/**
 * 공용 실행(`launchTree`)의 경계 대역. 시험 파일에서
 * `vi.mock("@babojubot/process", async (original) => (await import("./test-folders.ts")).owningLaunchTree(await original()))`로
 * 건다(연결 실패 대역 `connect-failure-support.ts`와 같은 쓰임). 띄운 트리마다 그 파일의 `testFolders`가 실제 끄기를 띄운 직후
 * 폴더 정리에 맡긴다(`treeScene`). 맡을 `testFolders`가 없으면 띄우지 않고 던진다.
 */
export function owningLaunchTree<
  P extends { launchTree: (...args: never[]) => StoppableTree },
>(real: P): P {
  boundary = true;
  const launchTree = ((...args: Parameters<P["launchTree"]>) => {
    if (!treeOwner)
      throw new Error(
        "no test folder owns the trees launched in this file; create testFolders() before launching"
      );
    return treeOwner(real.launchTree(...args));
  }) as P["launchTree"];
  return { ...real, launchTree };
}

/**
 * 이 시험에서 띄우는 트리의 장면. 정리는 각 트리의 실제 끄기 결과를 판정한다: 성공(트리 전체와 감독 실행기의 끝)만 통과하고, 그 밖의
 * 실패(`SUPERVISOR_NOT_ENDED` 등)는 정리 실패다.
 * - `expectStop: "TREE_LEFT"`: 실행기가 남은 프로그램이 있다고 답하는 장면. 그 답은 실행기가 끝난 뒤에만 오므로(실제 끄기는 실행기가
 *   끝난 것을 확인하거나 강제로 끝낸 뒤에 답을 판정한다) 이 코드 하나는 받는다. 그때 확인되는 것은 실행기의 끝뿐이고, 남은 프로그램의
 *   끝은 그 장면이 따로 맡은 정리가 확인해야 한다.
 * - `failProductStop`: 제품에는 실패로 답하는 끄기를 돌려준다(실제 트리는 바꾸지 않는다). `"without-stopping"`은 아무것도 끄지 않고,
 *   `"after-stopping"`은 실제로 끈 뒤 실패로 답한다. 제품이 그 끄기에 넘긴 인수는 `treeScene`이 돌려주는 `calls`에 남는다.
 */
type TreeScene = {
  expectStop?: "TREE_LEFT";
  failProductStop?: "without-stopping" | "after-stopping";
};

/** 시험이 만든 프로바이더 연결. 멈춤 신호를 받는 호출(실행·준비 확인·압축·모델 목록)을 정리가 맡는다. */
type Provider = {
  adapter: RuntimeAdapter;
  listModels?: (signal: AbortSignal) => Promise<unknown>;
};

/**
 * 시험 폴더와 그 정리(`@babojubot/process/testing`의 `testFolders`)에 프로바이더 연결 맡기기를 더한다. 정리는 맡긴 것을 늦게 맡긴
 * 것부터 멈추고 끝나기를 기다린 뒤에만 폴더를 지운다. `ownProvider`·`owning`으로 맡긴 실행 시도·준비 확인·압축·모델 목록 조회도
 * 같은 차례에 든다.
 */
export function testFolders(...args: Parameters<typeof processFolders>) {
  const folders = processFolders(...args);
  /** 이 시험의 트리 장면. 정한 시험의 정리가 끝나면 비운다(다음 시험에 남지 않는다). */
  let scene: TreeScene = {};
  /** 공용 실행 경계 대역이 띄운 트리. 실제 끄기를 띄운 직후 폴더 정리에 맡기고, 장면(`scene`)으로 판정한다. */
  const ownLaunchedTree = <T extends StoppableTree>(
    tree: T,
    { expectStop, failProductStop }: TreeScene,
    calls: unknown[][] = []
  ): T => {
    folders.own(async () => {
      try {
        await tree.stop();
      } catch (error) {
        if (expectStop === undefined || failureCode(error) !== expectStop)
          throw error;
      }
    }, "a launched tree, by its real stop");
    if (!failProductStop) return tree;
    return {
      ...tree,
      stop: async (...received: Parameters<T["stop"]>) => {
        calls.push(received);
        if (failProductStop === "after-stopping") await tree.stop(...received);
        throw new Error(
          "programs of this tree did not end (left: 1 (the tree did not end))"
        );
      },
    };
  };
  /** 이 시험의 장면에서 제품이 실패로 답하는 끄기에 넘긴 인수. */
  let sceneCalls: unknown[][] = [];
  const ownTree = <T extends StoppableTree>(tree: T): T =>
    ownLaunchedTree(tree, scene, sceneCalls);
  // 경계 대역을 건 파일(대역은 시험 파일이 공용 실행을 처음 가져올 때 걸린다)에서만 트리를 맡는다. 그런 파일의 둘째 `testFolders`는 던진다.
  if (boundary) {
    if (treeOwner)
      throw new Error(
        "a test file with the launchTree boundary double creates one testFolders(); a second one would leave it unclear which cleanup owns the trees"
      );
    treeOwner = ownTree;
  }
  /** 이 폴더 정리가 공용 실행 경계 대역의 트리를 맡는가. 아니면 트리 장면과 `ownBrokenRun`은 던진다. */
  const ownsTrees = () => {
    if (treeOwner !== ownTree)
      throw new Error(
        "this testFolders() does not own launched trees: the file needs the launchTree boundary double (owningLaunchTree) and one testFolders()"
      );
  };
  /**
   * 정리가 멈춤 신호를 보내고 돌아오기를 기다리는 호출. 시험이 넘긴 신호도 그대로 듣는다. 호출이 돌아온 것은 그 프로그램이 끝났다는
   * 증거가 아니다: 제품 프로바이더는 프로그램의 끝을 확인하지 못해도(실행 시도의 `broken`) 정상으로 돌아오고, 그 사실을 돌려주는
   * 값이 없다. 그래서 이 정리는 끝을 확인하지 않는다. 끝의 확인은 #286 3b-3에서 고정물이 쥔 연결로 더한다.
   */
  const ownCall = <R>(
    signal: AbortSignal,
    start: (signal: AbortSignal) => Promise<R>
  ) => {
    const stop = new AbortController();
    const started = start(AbortSignal.any([signal, stop.signal]));
    folders.own(async () => {
      stop.abort();
      // 실행의 실패는 시험이 결과로 본다. 정리는 호출이 돌아오기만 기다린다(프로그램의 끝은 확인하지 못한다).
      await Promise.allSettled([started]);
    }, "provider run");
    return started;
  };
  /**
   * 시험이 만든 프로바이더 연결. 그 연결로 시작한 실행 시도·준비 확인·압축·모델 목록 조회를 정리가 맡는다.
   * 시험이 결과를 기다리기 전에 단언·시한으로 실패해도, 정리가 멈춤 신호를 보내고 그 호출이 돌아온 뒤에 폴더를 지운다.
   * 호출이 돌아와도 폴더 안의 프로그램이 끝났는지는 확인하지 못한다(위 `ownCall`).
   */
  /** 이미 정리에 맡긴 adapter. 같은 연결을 다시 맡겨도 실행이 두 번 등록되지 않는다(두 번 기다리고 두 번 실패를 알리지 않는다). */
  const owned = new WeakSet<RuntimeAdapter>();
  const ownProvider = <T extends Provider>(provider: T): T => {
    if (owned.has(provider.adapter)) return provider;
    const { adapter, listModels } = provider;
    const { precompact } = adapter;
    const ownedAdapter: RuntimeAdapter = {
      ...adapter,
      execute: (request, control) =>
        ownCall(control.signal, (signal) =>
          adapter.execute(request, { ...control, signal })
        ),
      checkReadiness: (signal) =>
        ownCall(signal, (joined) => adapter.checkReadiness(joined)),
      ...(precompact && {
        precompact: (request, signal) =>
          ownCall(signal, (joined) => precompact(request, joined)),
      }),
    };
    owned.add(ownedAdapter);
    return {
      ...provider,
      adapter: ownedAdapter,
      ...(listModels && {
        listModels: (signal: AbortSignal) =>
          ownCall(signal, (joined) => listModels(joined)),
      }),
    };
  };
  /**
   * 시험이 띄운 실행 시도(`startProcess`)를 정리에 맡긴다. 정리는 입력을 닫아 끝내고(`end`), 끄기 유예가 시험의 가짜 시계(`clock`) 위면
   * 그 타이머까지 시계를 옮긴 뒤, 실행 시도의 끝(`done`)을 정리 상한 안에서 기다린다. 띄운 직후 맡겨, 시험이 어디서 실패하든 실행
   * 시도가 끝난 뒤에만 폴더를 지운다.
   * `done`의 이행은 실행 시도가 돌아왔다는 것일 뿐 프로그램이 끝났다는 증거가 아니다: 제품은 트리의 끝을 확인하지 못하거나 정리
   * 단계가 실패해도 `broken: true`로 이행한다. 그래서 `broken`이면 정리 실패로 드러내 폴더를 남긴다(`testFolders`의 원칙). 일부러
   * `broken`으로 끝나는 실행 시도는 여기 맡기지 않고 `ownBrokenRun`에 맡긴다.
   */
  const ownRun = <
    T extends { end: () => void; done: Promise<{ broken: boolean }> },
  >(
    run: T,
    clock?: {
      untilNext: () => number | undefined;
      advance: (ms: number) => void;
    }
  ): T => {
    folders.own(async () => {
      run.end();
      if (clock) {
        const stop = clock.untilNext();
        if (stop !== undefined) clock.advance(stop);
      }
      if ((await run.done).broken)
        throw new Error(
          "the run attempt ended without confirming that its programs and their cleanup ended (broken); its folder is kept"
        );
    }, "run attempt");
    return run;
  };
  /**
   * 일부러 `broken`으로 끝나는 실행 시도(시작 실패·입력 실패·주입한 끄기 실패·트리 밖 프로그램). `done`은 끝의 증거가 아니므로
   * 판정하지 않는다. 정리는 실행 시도를 끝내고 제품의 일(기록·출력 닫기)이 끝나기를 기다릴 뿐이다. 트리의 끝은 공용 실행 경계 대역이
   * 띄운 직후 맡은 실제 끄기가 확인한다(`treeScene`): 성공이면 트리 전체와 감독 실행기의 끝, `expectStop: "TREE_LEFT"` 장면이면 감독
   * 실행기의 끝뿐이고 남은 프로그램은 그 장면이 따로 맡은 정리가 확인한다. 그 대역이 없는 파일에서는 던진다.
   */
  const ownBrokenRun = <
    T extends { end: () => void; done: Promise<{ broken: boolean }> },
  >(
    run: T
  ): T => {
    ownsTrees();
    folders.own(async () => {
      run.end();
      await run.done;
    }, "deliberately broken run attempt");
    return run;
  };
  return {
    ...folders,
    ownRun,
    ownBrokenRun,
    /** 공용 실행 경계 대역이 띄운 트리를 장면과 함께 맡는 정리(대역은 이 시험의 장면으로 부른다). 판정 시험이 전역 상태 없이 부르도록 내보낸다. */
    ownLaunchedTree,
    /** 이 시험에서 띄우는 트리의 장면(위 `TreeScene`). 띄우기 전에 정한다. 시험이 끝나면 정리가 되돌린다. */
    treeScene(next: TreeScene) {
      ownsTrees();
      scene = next;
      const calls: unknown[][] = [];
      sceneCalls = calls;
      folders.own(async () => {
        scene = {};
        sceneCalls = [];
      }, "tree scene");
      return { calls };
    },
    /** 시험이 만든 프로바이더 연결을 정리에 맡긴다(위 `ownProvider`). */
    ownProvider,
    /**
     * 프로바이더 factory를 감싼다. 만든 연결은 모두 `ownProvider`로 정리에 맡긴다. 시험 파일은 가져온 factory를 이것으로 한 번
     * 묶어 쓰므로, 시험 표(describe.each·it.each)나 연결 설정에 값으로 넘긴 factory로 만든 연결도 빠지지 않는다.
     */
    owning<A extends unknown[], T extends Provider>(create: (...args: A) => T) {
      return (...args: A): T => ownProvider(create(...args));
    },
  };
}

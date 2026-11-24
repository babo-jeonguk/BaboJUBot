import type { RuntimeAdapter } from "@babojubot/contracts";
import { testFolders as processFolders } from "@babojubot/process/testing";

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
  /** 정리가 멈춤 신호를 보내고 끝나기를 기다리는 호출. 시험이 넘긴 신호도 그대로 듣는다. */
  const ownCall = <R>(
    signal: AbortSignal,
    start: (signal: AbortSignal) => Promise<R>
  ) => {
    const stop = new AbortController();
    const started = start(AbortSignal.any([signal, stop.signal]));
    folders.own(async () => {
      stop.abort();
      // 실행의 실패는 시험이 결과로 본다. 정리는 끝났는지만 기다린다.
      await Promise.allSettled([started]);
    }, "provider run");
    return started;
  };
  /**
   * 시험이 만든 프로바이더 연결. 그 연결로 시작한 실행 시도·준비 확인·압축·모델 목록 조회를 정리가 맡는다.
   * 시험이 결과를 기다리기 전에 단언·시한으로 실패해도, 정리가 멈춤 신호를 보내고 그 호출이 끝난 뒤에 폴더를 지운다.
   * 프로바이더는 프로그램과 그 정리가 끝난 뒤에 반환하므로, 호출이 끝나면 폴더 안의 프로그램도 끝났다.
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
   * 그 타이머까지 시계를 옮긴 뒤, 정리의 끝(`done`)을 정리 상한 안에서 기다린다. 이미 끝난 실행 시도에는 할 일이 없다. 실행의 결과는
   * 시험이 본다. 띄운 직후 맡겨, 시험이 어디서 실패하든 실행 시도가 끝난 뒤에만 폴더를 지운다.
   */
  const ownRun = <T extends { end: () => void; done: Promise<unknown> }>(
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
      await Promise.allSettled([run.done]);
    }, "run attempt");
    return run;
  };
  return {
    ...folders,
    ownRun,
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

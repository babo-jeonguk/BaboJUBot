// 실제 프로바이더 점검(scripts/provider-live.mjs)의 장면 고르기와 판정. 실제 호출 없이 시험한다(provider-scenes.test.mjs).
// 장애 검사(scripts/live/chaos-budget.mjs `parseLaunch`)처럼 모르는 장면·빈 선택은 호출 전에 거부하고, 고른 장면이 모두 돌아
// 확인한 항목으로 성공했을 때만 전체를 성공으로 본다. 아무 장면도 돌지 않은 실행이나 데이터 없이 끝난 장면은 성공이 아니다.

/** 장면과 그 장면이 기대는 연결의 기능. 기능이 없는 연결에서는 고르지 않으면 돌지 않고, 고르면 거부한다. */
export const liveScenes = [
  { id: "finish" },
  { id: "background" },
  { id: "resume" },
  // 세션 유지 정보(토큰 수·유지 시간)는 미리 압축을 하는 연결만 남긴다.
  { id: "usage-and-transcript", needs: "precompact" },
  { id: "steer", needs: "steer" },
  { id: "cancel" },
  { id: "unusable-session" },
  { id: "precompact", needs: "precompact" },
];

/** 장면 선택을 받아들일 수 없다. 실제 호출 전에 알린다. */
export class ScenesRefused extends Error {}

/**
 * 명령줄의 나머지 인자(`--record`, `--scenes=a,b`)에서 기록 여부와 돌릴 장면을 정한다. 장면을 고르지 않으면 이 연결이 할 수 있는
 * 모든 장면이다. 모르는 인자·장면, 빈 선택, 이 연결의 기능이 없는 장면을 거부한다. 연결을 만들기 전(기록 폴더를 만들기 전)에는
 * `capabilities`를 `null`로 넘겨 인자만 확인하고, 연결을 만든 뒤 그 기능으로 다시 정한다.
 */
export function parseScenes(flags, capabilities) {
  const sceneFlags = flags.filter((flag) => flag.startsWith("--scenes="));
  for (const flag of flags)
    if (flag !== "--record" && !flag.startsWith("--scenes="))
      throw new ScenesRefused(`unknown argument ${flag}`);
  if (sceneFlags.length > 1) throw new ScenesRefused("give --scenes= once");
  const supported = (scene) =>
    !scene.needs || capabilities === null || !!capabilities[scene.needs];
  if (sceneFlags.length === 0)
    return {
      record: flags.includes("--record"),
      scenes: liveScenes.filter(supported).map((scene) => scene.id),
    };
  const chosen = sceneFlags[0]
    .slice("--scenes=".length)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (chosen.length === 0) throw new ScenesRefused("no scene selected");
  for (const id of chosen) {
    const scene = liveScenes.find((each) => each.id === id);
    if (!scene)
      throw new ScenesRefused(
        `unknown scene "${id}" (one of ${liveScenes.map((each) => each.id).join(", ")})`
      );
    if (!supported(scene))
      throw new ScenesRefused(
        `scene "${id}" needs the connection's ${scene.needs} capability`
      );
  }
  return { record: flags.includes("--record"), scenes: chosen };
}

/** 고른 장면 결과를 판정한다. 고른 장면마다 결과가 있고 그 결과가 `ok: true`일 때만 성공이다. */
export function verdict(results, scenes) {
  const ran = new Map(results.map((result) => [result.scene, result]));
  const missing = scenes.filter((id) => !ran.has(id));
  const passed = scenes.filter((id) => ran.get(id)?.ok === true);
  const failed = scenes.filter((id) => ran.has(id) && ran.get(id).ok !== true);
  return {
    passed,
    failed,
    missing,
    ok: scenes.length > 0 && passed.length === scenes.length,
  };
}

/** 세션 유지 정보가 실제로 남았는지 본다. 세션이 없거나 수치가 없으면 그 이유와 함께 실패다. */
export function usageFacts(row, now = Date.now()) {
  const maintenance = row?.maintenance;
  const facts = maintenance
    ? {
        tokens: maintenance.tokens,
        ttlMs: maintenance.ttlMs,
        lastRequestAgeSeconds:
          (now - Date.parse(maintenance.lastRequestAt)) / 1000,
        tools: maintenance.tools?.length ?? 0,
      }
    : null;
  return {
    ok:
      typeof row?.state?.id === "string" &&
      facts !== null &&
      Number.isFinite(facts.tokens) &&
      facts.tokens > 0 &&
      Number.isFinite(facts.ttlMs) &&
      facts.ttlMs > 0 &&
      Number.isFinite(facts.lastRequestAgeSeconds) &&
      facts.lastRequestAgeSeconds >= 0,
    noSession: !row,
    maintenance: facts,
    sessionKeys: Object.keys(row?.state ?? {}),
  };
}

/** 쓸 수 없는 세션(`fake`)을 받은 뒤 새 세션으로 옮겼는가. 세션이 없으면 옮긴 것이 아니다. */
export const movedToFreshSession = ({ previousId, fake, after }) =>
  typeof after === "string" && after !== fake && after !== previousId;

/** 앞뒤 세션이 모두 있고 같은 세션인가. 둘 다 없으면 같은 세션이 아니다. */
export const sameSession = (beforeId, afterId) =>
  typeof beforeId === "string" && beforeId === afterId;

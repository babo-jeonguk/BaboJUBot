// `ci / test` 판정이 실패로 센 job마다 실패 이유를 붙인다(#218). 판정 결과는 바꾸지 않는다.
// 분류는 현재 시도(run_attempt)의 job 기록과 그 check run 주석만 읽는다. 조회가 실패하면 그 job은 "알 수 없음"이다.
// GitHub API 응답은 `fetch`로 주입받아 시험한다(scripts/ci-job-failures.test.mjs).

export const kindLabels = {
  test: "시험 실패",
  unassigned: "실행 컴퓨터 미배정",
  cancelled: "취소",
  unknown: "알 수 없음",
};

// 실행 컴퓨터를 받지 못한 job에 GitHub가 남기는 주석. 공개 API 계약은 아니므로 다른 세 표시와 함께일 때만 믿는다.
const notAcquired = /The job was not acquired by Runner/;
const requestTimeoutMs = 10_000;
// 끝나지 않고 멈춘 job이 판정 입력(needs.<job>.result)에 오는 값.
const stoppedResults = new Set(["cancelled", "abandoned"]);
// 판정 job(5분) 안에서 조회 전체가 끝나도록 둔 상한. 넘으면 남은 job은 "알 수 없음"이다.
const lookupDeadlineMs = 60_000;

/**
 * @param {{ name: string, result: string, expected: string }[]} failures 판정이 실패로 센 job
 * @param {{ apiUrl?: string, repository?: string, runId?: string, runAttempt?: string, token?: string,
 *   fetch?: typeof globalThis.fetch, deadline?: AbortSignal }} context 조회 전체 시한(`deadline`)은 시험이 신호로 넣는다. 기본은 60초다.
 * @returns {Promise<{ name: string, result: string, expected: string, kind: keyof kindLabels, reason: string }[]>}
 */
export async function classifyFailures(failures, context) {
  if (failures.length === 0) return [];
  context = {
    ...context,
    deadline: context.deadline ?? AbortSignal.timeout(lookupDeadlineMs),
  };
  let jobs;
  try {
    jobs = await listAttemptJobs(context);
  } catch (error) {
    return unknownRows(failures, `job 목록 조회 실패: ${message(error)}`);
  }
  const attempt = Number(context.runAttempt);
  const rows = [];
  for (const each of failures) {
    // 이전 시도의 같은 이름 job은 이번 판정의 근거가 아니다.
    const matches = jobs.filter(
      (job) => job.name === each.name && job.run_attempt === attempt
    );
    if (matches.length !== 1) {
      rows.push({
        ...each,
        kind: "unknown",
        reason: `시도 ${attempt}의 job 기록 ${matches.length}개`,
      });
      continue;
    }
    rows.push({ ...each, ...(await classifyJob(each, matches[0], context)) });
  }
  return rows;
}

/** 분류하지 못한 실패를 "알 수 없음"으로 남긴다. */
export function unknownRows(failures, reason) {
  return failures.map((each) => ({ ...each, kind: "unknown", reason }));
}

async function classifyJob(failure, job, context) {
  const stepCount = job.steps?.length ?? 0;
  const hasRunner = job.runner_id > 0;
  const ran = hasRunner && stepCount > 0;
  if (failure.result === "failure") {
    const failed = (job.steps ?? []).filter(
      (step) => step.conclusion === "failure"
    );
    if (job.conclusion === "failure" && ran && failed.length > 0)
      return {
        kind: "test",
        reason: `실패한 단계: ${failed.map((step) => step.name).join(", ")}`,
      };
    return {
      kind: "unknown",
      reason: `결과 failure, 실패한 단계 ${failed.length}개`,
    };
  }
  // 실행 컴퓨터를 받지 못한 job은 판정 입력에 'abandoned'로 오기도 한다(run 44134168705). job 기록은 둘 다 cancelled다.
  if (!stoppedResults.has(failure.result) || job.conclusion !== "cancelled")
    return {
      kind: "unknown",
      reason: `판정 입력 '${failure.result}', job 기록 '${job.conclusion}'`,
    };
  let hasNotAcquiredNote;
  try {
    const notes = await fetchAll(
      `${base(context)}/repos/${context.repository}/check-runs/${job.id}/annotations`,
      context,
      (body) => body
    );
    hasNotAcquiredNote = notes.some((each) =>
      notAcquired.test(each.message ?? "")
    );
  } catch (error) {
    return { kind: "unknown", reason: `주석 조회 실패: ${message(error)}` };
  }
  const signs = `실행기 ${hasRunner ? "있음" : "없음"}, 단계 ${stepCount}개, 미배정 주석 ${hasNotAcquiredNote ? "있음" : "없음"}`;
  if (!hasRunner && stepCount === 0 && hasNotAcquiredNote)
    return { kind: "unassigned", reason: signs };
  // 실행기를 받아 단계가 돈 뒤 끊긴 job은 사람이 취소했거나 concurrency가 취소했다.
  // 미배정 표시가 일부만 있으면(예: 대기 중 취소돼 실행기·단계·주석이 모두 없음) 알 수 없음이다(#218).
  if (ran && !hasNotAcquiredNote) return { kind: "cancelled", reason: signs };
  return { kind: "unknown", reason: signs };
}

async function listAttemptJobs(context) {
  for (const key of ["repository", "runId", "runAttempt", "token"])
    if (!context[key]) throw new Error(`${key} 없음`);
  return fetchAll(
    `${base(context)}/repos/${context.repository}/actions/runs/${context.runId}/attempts/${context.runAttempt}/jobs`,
    context,
    (body) => body.jobs
  );
}

// 모든 쪽을 읽는다. 다음 쪽은 GitHub가 준 Link 헤더의 rel="next"를 따른다.
async function fetchAll(url, context, pickList) {
  const fetch = context.fetch ?? globalThis.fetch;
  const all = [];
  let next = `${url}?per_page=100&page=1`;
  for (let page = 0; next; page += 1) {
    if (page >= 50) throw new Error("쪽이 너무 많음");
    const response = await fetch(next, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${context.token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.any([
        context.deadline,
        AbortSignal.timeout(requestTimeoutMs),
      ]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const list = pickList(await response.json());
    if (!Array.isArray(list)) throw new Error("예상과 다른 응답");
    all.push(...list);
    next = /<([^>]+)>;\s*rel="next"/.exec(
      response.headers.get("link") ?? ""
    )?.[1];
  }
  return all;
}

const base = (context) =>
  (context.apiUrl || "https://api.github.com").replace(/\/$/, "");
const message = (error) =>
  error instanceof Error ? error.message : String(error);

/** 판정 job 로그와 job summary에 함께 쓰는 표. 실패가 없으면 "실패 없음"이다. */
export function renderReport(rows, notes = []) {
  const lines = ["## ci / test 실패 이유", ""];
  for (const note of notes) lines.push(`- ${note}`);
  if (notes.length) lines.push("");
  if (rows.length === 0) {
    if (notes.length === 0) lines.push("실패 없음");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "| job | 결과 | 기대 | 분류 | 근거 |",
    "| --- | --- | --- | --- | --- |"
  );
  for (const row of rows)
    lines.push(
      `| ${cell(row.name)} | ${cell(row.result || "없음")} | ${cell(row.expected)} | ${kindLabels[row.kind]} | ${cell(row.reason)} |`
    );
  return `${lines.join("\n")}\n`;
}

const cell = (text) => String(text).replaceAll("|", "\\|").replace(/\s+/g, " ");

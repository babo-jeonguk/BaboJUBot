import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailures, renderReport } from "./ci-job-failures.mjs";

const api = "https://api.github.test";
const repository = "owner/repo";
const runId = "43910774802";
const context = (overrides = {}) => ({
  apiUrl: api,
  repository,
  runId,
  runAttempt: "1",
  token: "token",
  ...overrides,
});

// 실제 미배정 기록(run 43910774802의 runtime on macos-latest)과 같은 모양이다.
const unassignedJob = {
  id: 133451917895,
  name: "runtime on macos-latest",
  run_attempt: 1,
  status: "completed",
  conclusion: "cancelled",
  runner_id: 0,
  runner_name: "",
  steps: [],
};
const unassignedNote = {
  annotation_level: "failure",
  message:
    "The job was not acquired by Runner of type hosted even after multiple attempts",
};
const capacityNote = {
  annotation_level: "notice",
  message:
    "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.",
};
const ranJob = (overrides) => ({
  id: 1,
  run_attempt: 1,
  status: "completed",
  runner_id: 1000008047,
  runner_name: "GitHub Actions 1000008047",
  steps: [
    { name: "Set up job", conclusion: "success" },
    { name: "Run tests", conclusion: "failure" },
  ],
  ...overrides,
});

// GitHub REST 응답을 흉내 낸다. 주소(경로+질의)마다 응답 하나를 준다. 모르는 주소는 404다.
function fakeApi(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const route = routes[String(url).slice(api.length)];
    if (route instanceof Error) throw route;
    // 응답하지 않는 서버: 호출자가 신호로 끊을 때까지 기다린다.
    if (route === "hang")
      return new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason))
      );
    const { status = 200, body, link } = route ?? { status: 404, body: {} };
    return new Response(JSON.stringify(body), {
      status,
      headers: link ? { link } : {},
    });
  };
  return { fetch, calls };
}
const jobsPath = (page = 1, attempt = 1) =>
  `/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`;
const notesPath = (id) =>
  `/repos/${repository}/check-runs/${id}/annotations?per_page=100&page=1`;
const failure = (name, result = "cancelled", expected = "success") => ({
  name,
  result,
  expected,
});

test("calls a cancelled job with no runner, no steps and the not-acquired note unassigned", async () => {
  const { fetch } = fakeApi({
    [jobsPath()]: { body: { total_count: 1, jobs: [unassignedJob] } },
    [notesPath(unassignedJob.id)]: { body: [unassignedNote, capacityNote] },
  });
  const [row] = await classifyFailures(
    [failure("runtime on macos-latest")],
    context({ fetch })
  );
  assert.equal(row.kind, "unassigned");
});

for (const [what, job, notes] of [
  ["a runner", { ...unassignedJob, runner_id: 7 }, [unassignedNote]],
  [
    "a step",
    {
      ...unassignedJob,
      steps: [{ name: "Set up job", conclusion: "success" }],
    },
    [unassignedNote],
  ],
  ["no not-acquired note", unassignedJob, [capacityNote]],
]) {
  test(`calls a cancelled job with ${what} unknown, not unassigned`, async () => {
    const { fetch } = fakeApi({
      [jobsPath()]: { body: { total_count: 1, jobs: [job] } },
      [notesPath(job.id)]: { body: notes },
    });
    const [row] = await classifyFailures(
      [failure(job.name)],
      context({ fetch })
    );
    assert.equal(row.kind, "unknown");
  });
}

test("calls a job cancelled after it ran cancelled", async () => {
  const job = ranJob({
    id: 9,
    name: "tests / server",
    conclusion: "cancelled",
    steps: [
      { name: "Set up job", conclusion: "success" },
      { name: "Run server tests", conclusion: "cancelled" },
    ],
  });
  const { fetch } = fakeApi({
    [jobsPath()]: { body: { total_count: 1, jobs: [job] } },
    [notesPath(9)]: {
      body: [
        { annotation_level: "failure", message: "The operation was canceled." },
      ],
    },
  });
  const [row] = await classifyFailures([failure(job.name)], context({ fetch }));
  assert.equal(row.kind, "cancelled");
});

test("calls a job whose step failed a test failure and names the step", async () => {
  const job = ranJob({ id: 3, name: "tests / unit", conclusion: "failure" });
  const { fetch, calls } = fakeApi({
    [jobsPath()]: { body: { total_count: 1, jobs: [job] } },
  });
  const [row] = await classifyFailures(
    [failure(job.name, "failure")],
    context({ fetch })
  );
  assert.equal(row.kind, "test");
  assert.match(row.reason, /Run tests/);
  // 시험 실패는 주석을 읽지 않는다.
  assert.equal(calls.length, 1);
});

test("calls a cancelled job unknown when its notes cannot be read", async () => {
  const { fetch } = fakeApi({
    [jobsPath()]: { body: { total_count: 1, jobs: [unassignedJob] } },
    [notesPath(unassignedJob.id)]: { status: 500, body: {} },
  });
  const [row] = await classifyFailures(
    [failure(unassignedJob.name)],
    context({ fetch })
  );
  assert.equal(row.kind, "unknown");
  assert.match(row.reason, /주석 조회 실패: HTTP 500/);
});

test("calls every failure unknown when the job list cannot be read", async () => {
  for (const fetch of [
    fakeApi({ [jobsPath()]: new TypeError("fetch failed") }).fetch,
    fakeApi({ [jobsPath()]: { status: 403, body: {} } }).fetch,
  ]) {
    const rows = await classifyFailures(
      [failure("tests / unit", "failure"), failure(unassignedJob.name)],
      context({ fetch })
    );
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["unknown", "unknown"]
    );
  }
});

test("calls every failure unknown without a token or run, and asks nothing", async () => {
  const { fetch, calls } = fakeApi({});
  const [row] = await classifyFailures(
    [failure(unassignedJob.name)],
    context({ fetch, token: "", runId: undefined })
  );
  assert.equal(row.kind, "unknown");
  assert.equal(calls.length, 0);
});

test("reads every page of the job list", async () => {
  const filler = Array.from({ length: 100 }, (_, i) =>
    ranJob({ id: 1000 + i, name: `other ${i}`, conclusion: "success" })
  );
  const { fetch, calls } = fakeApi({
    [jobsPath(1)]: {
      body: { total_count: 101, jobs: filler },
      link: `<${api}${jobsPath(2)}>; rel="next", <${api}${jobsPath(2)}>; rel="last"`,
    },
    [jobsPath(2)]: {
      body: { total_count: 101, jobs: [unassignedJob] },
      link: `<${api}${jobsPath(1)}>; rel="first", <${api}${jobsPath(1)}>; rel="prev"`,
    },
    [notesPath(unassignedJob.id)]: { body: [unassignedNote] },
  });
  const [row] = await classifyFailures(
    [failure(unassignedJob.name)],
    context({ fetch })
  );
  assert.equal(row.kind, "unassigned");
  assert.deepEqual(
    calls.slice(0, 2).map((call) => call.url),
    [`${api}${jobsPath(1)}`, `${api}${jobsPath(2)}`]
  );
  assert.equal(calls[0].init.headers.authorization, "Bearer token");
});

// 실패한 job만 다시 돌린 2번째 시도: 목록에 1번째 시도의 같은 이름 job이 섞여 있다.
test("reads only the current attempt and ignores the same job from an earlier attempt", async () => {
  const earlier = { ...unassignedJob, id: 1 };
  const current = ranJob({
    id: 2,
    name: unassignedJob.name,
    run_attempt: 2,
    conclusion: "failure",
  });
  const { fetch, calls } = fakeApi({
    [jobsPath(1, 2)]: { body: { total_count: 2, jobs: [earlier, current] } },
  });
  const [row] = await classifyFailures(
    [failure(unassignedJob.name, "failure")],
    context({ fetch, runAttempt: "2" })
  );
  assert.equal(row.kind, "test");
  assert.equal(calls[0].url, `${api}${jobsPath(1, 2)}`);
});

test("calls a failure unknown when the current attempt has no record of the job", async () => {
  const { fetch } = fakeApi({
    [jobsPath(1, 2)]: { body: { total_count: 1, jobs: [unassignedJob] } },
  });
  const [row] = await classifyFailures(
    [failure(unassignedJob.name)],
    context({ fetch, runAttempt: "2" })
  );
  assert.equal(row.kind, "unknown");
});

test("classifies an unassigned job and a test failure in the same run separately", async () => {
  const unit = ranJob({ id: 3, name: "tests / unit", conclusion: "failure" });
  const { fetch } = fakeApi({
    [jobsPath()]: { body: { total_count: 2, jobs: [unit, unassignedJob] } },
    [notesPath(unassignedJob.id)]: { body: [unassignedNote] },
  });
  const rows = await classifyFailures(
    [failure("tests / unit", "failure"), failure(unassignedJob.name)],
    context({ fetch })
  );
  assert.deepEqual(
    rows.map((row) => [row.name, row.kind]),
    [
      ["tests / unit", "test"],
      ["runtime on macos-latest", "unassigned"],
    ]
  );
  const report = renderReport(rows);
  assert.match(
    report,
    /\| tests \/ unit \| failure \| success \| 시험 실패 \|/
  );
  assert.match(
    report,
    /\| runtime on macos-latest \| cancelled \| success \| 실행 컴퓨터 미배정 \|/
  );
});

test("reports no failures", () => {
  assert.match(renderReport([]), /실패 없음/);
});

// 대기 중에 사람이나 concurrency가 취소한 job은 실행기·단계·주석이 모두 없다. 미배정 표시 일부만 맞으므로 알 수 없음이다.
test("calls a job cancelled while still queued unknown", async () => {
  const { fetch } = fakeApi({
    [jobsPath()]: { body: { total_count: 1, jobs: [unassignedJob] } },
    [notesPath(unassignedJob.id)]: { body: [] },
  });
  const [row] = await classifyFailures(
    [failure(unassignedJob.name)],
    context({ fetch })
  );
  assert.equal(row.kind, "unknown");
  assert.match(row.reason, /실행기 없음, 단계 0개, 미배정 주석 없음/);
});

test("gives up within the overall lookup deadline and calls the rest unknown", async () => {
  const { fetch } = fakeApi({
    [jobsPath()]: { body: { total_count: 1, jobs: [unassignedJob] } },
    [notesPath(unassignedJob.id)]: "hang",
  });
  const started = Date.now();
  const [row] = await classifyFailures(
    [failure(unassignedJob.name)],
    context({ fetch, deadlineMs: 200 })
  );
  assert.equal(row.kind, "unknown");
  assert.match(row.reason, /주석 조회 실패/);
  assert.ok(Date.now() - started < 5_000);
});

// run 44134168705의 files / macos: 실행 컴퓨터를 받지 못한 job이 판정 입력(needs.<job>.result)에는 'abandoned'로,
// job 기록에는 cancelled로 왔다. 판정 입력 값이 아니라 job 기록과 주석으로 분류한다.
test("calls an unassigned job unassigned when the gate input says abandoned", async () => {
  const job = { ...unassignedJob, id: 134219118748, name: "files / macos" };
  const { fetch } = fakeApi({
    [jobsPath()]: { body: { total_count: 1, jobs: [job] } },
    [notesPath(job.id)]: { body: [unassignedNote, capacityNote] },
  });
  const [row] = await classifyFailures(
    [failure(job.name, "abandoned")],
    context({ fetch })
  );
  assert.equal(row.kind, "unassigned");
});

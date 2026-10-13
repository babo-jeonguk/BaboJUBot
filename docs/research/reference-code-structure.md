# 프로젝트 초기 구조 참고 조사

조사일: 2026-10-12. 목적은 BaboJUBot의 파일·폴더 책임을 정하기 위한 공개 코드 구조 비교입니다. 기능의 실제 실행 검증, 외부 코드 복사, 의존성 설치와 메모리 관리 기법 선정은 이번 범위에 포함하지 않습니다.

## 전제와 확인 범위

- 사용자 요구를 기준으로 웹 대시보드를 높은 우선순위에 둡니다. Research Lead와의 대화 채널만 웹 채팅 또는 메신저 중 미정입니다.
- 조직별 독립 연구, 계획·팀 승인, 직접 협력, 에이전트/조직 중단·재개, heartbeat, 파일 기반 역할·성격, 예산·시간 정책을 담을 책임 경계를 찾습니다.
- 연구 과정은 목표 → 문제 → 가설·아이디어 → 검증 방법 → 실험 → 결과 관계를 표현하고 다른 연구 철학의 템플릿도 지원해야 합니다. 해당 구조는 BaboJUBot 요구이며 아래 참고 프로젝트가 이를 그대로 제공한다고 확인한 것은 아닙니다.
- 기억은 조직의 공통 맥락과 에이전트별 맥락을 구분하고 다른 조직에는 지정 공유만 허용합니다. 저장·검색 방식은 후속 조사로 남깁니다.
- GitHub 공식 저장소 metadata, 기본 브랜치 HEAD commit과 recursive Git tree를 API로 조회했습니다. 여섯 tree 모두 `truncated: false`입니다. README·workspace/package manifest·LICENSE·대표 구현 파일은 고정 SHA의 raw source로 읽었습니다. 큰 구현 파일은 경계·import·주요 선언을 중심으로 부분 검토했으며 전 코드를 감사한 것은 아닙니다.
- `Orca`는 동명이인이 있어 처음 stablyai/orca를 잠정 대상으로 조회했으며, 사용자가 **stablyai/orca를 의도한 대상으로 확인**했습니다.

## 확인한 버전

| 프로젝트 | 고정 commit | 루트 LICENSE 확인 |
|---|---|---|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/3569e8461ea721623fa16e6f01fb636157989fe6) | `3569e8461ea721623fa16e6f01fb636157989fe6` | MIT |
| [Paperclip](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54) | `1b4c803816e82b0265c8422e1a804327a7ed8c54` | MIT |
| [OpenClaw](https://github.com/openclaw/openclaw/tree/80f170ea263a21187384cb67d5aead87b1d01fc2) | `80f170ea263a21187384cb67d5aead87b1d01fc2` | MIT |
| [Rakazo](https://github.com/elie222/rakazo/tree/40ee8548763ca1050350210291048274610bef79) | `40ee8548763ca1050350210291048274610bef79` | Apache-2.0 |
| [Paseo](https://github.com/getpaseo/paseo/tree/9246813fd2acd6afc7012c5fde79a164b8f8592e) | `9246813fd2acd6afc7012c5fde79a164b8f8592e` | Apache-2.0, 내장 제3자 구성요소는 각자의 라이선스 유지 |
| [Orca](https://github.com/stablyai/orca/tree/564693f1765e58bea9aee9cf642b96230411a8cd) | `564693f1765e58bea9aee9cf642b96230411a8cd` | MIT |

라이선스 확인은 각 고정 버전의 루트 파일 기준입니다. 개별 파일을 재사용할 때에는 해당 파일·포함된 제3자 코드·NOTICE를 다시 확인해야 합니다. 현재는 설계 참고만 수행합니다. Paseo는 GitHub metadata가 `Other/NOASSERTION`으로 분류했지만 실제 [LICENSE](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/LICENSE)와 root package manifest에서 위 조건을 확인했습니다.

## 프로젝트별 구조와 참고 지점

### Paperclip: 관리 서버·대시보드·연결 모듈 분리

확인한 구조는 다음과 같습니다.

```text
server/src/
  routes/ services/ modules/ middleware/ realtime/ storage/
ui/src/
  api/ features/ pages/ components/ adapters/
packages/
  shared/src/           # 공용 타입과 검증 등
  db/src/schema/        # 데이터 정의
  adapters/             # 외부 agent 실행 도구별 구현
  adapter-utils/
  paperclip-runner/
cli/src/
tests/
```

[workspace manifest](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/pnpm-workspace.yaml)가 서버·UI·CLI·공용 패키지·어댑터를 별도 단위로 포함합니다. [승인 HTTP 경로](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/approvals.ts)와 [heartbeat 서비스](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat.ts)는 사용자 접점과 실행 조정의 분리를 보여줍니다. [agents schema](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/agents.ts)에는 회사 ID, 역할, 보고 대상, 어댑터 설정, 생명주기, 일시정지, 예산과 heartbeat 시각이 정의되어 있습니다.

**적용 판단:** 대시보드·서버·저장소·실행 연결을 분리합니다. Paperclip의 company 모델은 조직 경계 참고이며 연구 과정까지 동일하다고 가정하지 않습니다. 대형 heartbeat 서비스의 크기와 기능 수를 초기 코드로 그대로 가져오지 않습니다.

### Hermes Agent: 실행 엔진·채널 접점·프로필·도구 분리

```text
agent/                 # agent 실행과 prompt 구성
gateway/               # 채널 연결과 상시 접점
hermes_cli/            # 명령, 설정, 프로필 운영
acp_adapter/           # 외부 프로토콜 연결
tools/                 # 도구와 위임
cron/                  # 예약 실행
web/src/               # 웹 화면
hermes_state*.py        # 상태 저장 관련 모듈
SOUL.md
tests/ tests-js/
```

[pyproject](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/pyproject.toml), [prompt 구성](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/agent/prompt_builder.py), [gateway 진입 구현](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/gateway/run.py)을 검토했습니다. [profiles.py](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/hermes_cli/profiles.py)는 프로필 디렉토리 목록 및 설정·`SOUL.md` 등을 다루며, [SOUL.md](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/SOUL.md)는 응답 행동 원칙을 파일로 제공합니다. [web package](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/web/package.json)는 웹 접점의 별도 빌드 단위를 확인하는 근거입니다.

**적용 판단:** 역할·성격·행동 파일과 실제 실행 상태를 구분합니다. Hermes가 Python인 사실 때문에 BaboJUBot 전체를 Python으로 고정하지 않습니다. 외부 실행 도구와 제어 계약을 연결하는 경계를 둡니다. 기억 관련 디렉토리의 존재만 확인했으며 기법은 조사하지 않았습니다.

### OpenClaw: 에이전트·gateway·확장 채널·heartbeat 책임 분리

```text
src/
  agents/ gateway/ channels/ cron/ infra/ storage/ sessions/
ui/
packages/
  gateway-protocol/ gateway-client/ agent-core/ worker-runtime/
extensions/            # 채널·제공자 등의 확장
docs/reference/templates/
  SOUL.md HEARTBEAT.md AGENTS.md IDENTITY.md TOOLS.md
test/ + 인접 *.test.ts
```

[workspace manifest](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/pnpm-workspace.yaml)는 UI·packages·extensions를 구분합니다. [heartbeat 진입점](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/infra/heartbeat-runner.ts)은 실행·스케줄·세션·활성 여부를 별도 파일에서 재수출합니다. [agent-scope](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/agents/agent-scope.ts), [workspace](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/agents/workspace.ts), [SOUL 템플릿](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/reference/templates/SOUL.md), [gateway-protocol package](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/packages/gateway-protocol/package.json)을 부분 검토했습니다.

**적용 판단:** heartbeat 예약·실행·상태 기록을 구분하고, 에이전트별 설정과 실행 환경을 구분합니다. heartbeat라는 이름만 같다고 모든 프로젝트가 동일한 동작이나 중단 의미를 갖는다고 추정하지 않습니다. 채널 확장은 Lead 채팅 선택 이후의 연결 계층으로 둡니다.

### Rakazo: 앱·순수 규칙·공용 계약·어댑터 경계

```text
apps/
  api/src/ worker/src/ web/src/ desktop/ mobile/
packages/
  core/src/ contracts/src/ db/ adapter-kit/ adapters/
  chat-ui/ testkit/ logging/
infra/
```

[workspace manifest](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/pnpm-workspace.yaml), [API 조립](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/apps/api/src/app.ts), [worker 진입점](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/apps/worker/src/index.ts)을 확인했습니다. [core/run-state.ts](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/packages/core/src/run-state.ts)는 실행 상태 전이 허용표와 검증 함수를 공용 계약 타입에 대해 정의합니다. [contracts/events.ts](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/packages/contracts/src/events.ts)는 메시지·이벤트 스키마를, [adapter-kit 진입점](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/packages/adapter-kit/src/index.ts)은 인터페이스·registry·타입 재수출을 보여줍니다.

**적용 판단:** 연구·승인·작업의 순수 규칙을 HTTP 및 외부 실행 도구에서 분리하는 가장 직접적인 참고입니다. API와 worker를 별도 앱으로 둘 수 있으나 초기 배포에서 반드시 별도 서버·서비스로 운영할 필요는 없습니다.

### Paseo: 프로토콜·클라이언트·서버·화면 분리

```text
packages/
  protocol/src/       # 공용 메시지·상태 정의
  client/src/         # 서버 연결
  server/src/server/agent/
  app/src/            # 사용자 화면
  cli/ desktop/ relay/ plugin/
```

[root package workspaces](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/package.json), [server package exports](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/packages/server/package.json), [agent lifecycle](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/packages/protocol/src/agent-lifecycle.ts)을 확인했습니다. [AgentStorage](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/packages/server/src/server/agent/agent-storage.ts)는 저장 표현과 검증을 분리하며 atomic JSON writer를 사용합니다. [AgentManager](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/packages/server/src/server/agent/agent-manager.ts)와 [daemon client](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/packages/client/src/daemon-client.ts)는 생명주기 조정과 연결 책임의 부분 검토 근거입니다.

**적용 판단:** 대시보드는 실제 실행 상태의 계약을 소비하도록 만듭니다. UI 표시 상태와 실행 상태가 별개로 진실을 만들지 않도록 합니다. desktop·mobile·relay·음성 기능은 사용자 요구에 없는 초기 범위로 추가하지 않습니다.

### Orca: runtime·persistence·provider·화면·RPC 계약 분리

```text
src/
  main/runtime/       # 실행 조정
  main/persistence/  # 저장·복원
  main/providers/    # 실행 환경 추상화
  main/server/
  renderer/src/      # 사용자 화면
  shared/rpc-contract/
  cli/
cloud/ mobile/ tests/
```

[package manifest](https://github.com/stablyai/orca/blob/564693f1765e58bea9aee9cf642b96230411a8cd/package.json), [filesystem provider 계약](https://github.com/stablyai/orca/blob/564693f1765e58bea9aee9cf642b96230411a8cd/src/main/providers/filesystem-provider-contract.ts), [agent session RPC 매개변수](https://github.com/stablyai/orca/blob/564693f1765e58bea9aee9cf642b96230411a8cd/src/shared/rpc-contract/agent-session-params.ts), [atomic snapshot writer](https://github.com/stablyai/orca/blob/564693f1765e58bea9aee9cf642b96230411a8cd/src/main/persistence/atomic-snapshot-writer.ts), [serve readiness](https://github.com/stablyai/orca/blob/564693f1765e58bea9aee9cf642b96230411a8cd/src/main/server/serve-readiness.ts)를 검토했습니다.

**적용 판단:** 서버·실행 프로세스의 상태를 저장 및 화면 전송과 구분합니다. Electron 특유의 main/preload/renderer 구성은 웹 우선인 BaboJUBot에 그대로 적용하지 않습니다. 사용자가 해당 저장소를 확인했으므로 실제 비교 대상으로 사용하되, 웹에 필요한 책임 분리만 참고합니다.

## BaboJUBot에 권장하는 책임 경계 — 설계 판단

| 경계 | 담을 책임 | 참고 패턴 |
|---|---|---|
| 웹 앱 | 조직 목록·활동·승인·실행 제어·연구 트리 화면 | Paperclip UI, Rakazo web, Paseo app |
| API 앱 | 사용자 요청·권한·조회·실시간 이벤트 전달 | Paperclip routes/realtime, Rakazo api |
| worker 앱 | 대기 작업 소비·실행 계층 조립 | Rakazo worker |
| domain | 조직·팀·승인·연구 흐름·작업·완료·공유 규칙 | Rakazo core 상태 규칙 |
| contracts | 앱과 실행 연결 간 요청·상태·이벤트 형식 | Paseo protocol, Rakazo contracts, Orca RPC |
| runtime | heartbeat·작업 실행·대기·중단·재개·장애 복원 | OpenClaw heartbeat 모듈, Paperclip services |
| storage | 저장 구현·변경 이력·트랜잭션 | Paperclip db, Paseo storage, Orca persistence |
| adapters | Hermes/OpenClaw 등 실행 도구·채팅 채널·외부 도구 연결 | Paperclip adapters, Rakazo adapter-kit |
| profiles와 연구 템플릿 | 버전 관리할 ROLE/SOUL 파일 및 연구 흐름 정의 | Hermes SOUL, OpenClaw templates |
| 검증 | 조직 분리·승인 우회·중복 실행·재개·계약 호환 확인 | 참고 저장소의 tests 및 인접 test 구성 |

처음부터 독립 배포 서비스 여러 개를 만드는 제안은 아닙니다. 앱과 내부 모듈의 책임을 나눠 같은 저장소에서 개발하고, 실제 프로세스 분리는 필요할 때 결정합니다. `domain`과 `contracts`가 외부 실행 도구나 웹 프레임워크에 종속되지 않도록 하는 방향입니다. 초기 골격은 `apps/server`, `apps/worker`, `apps/web`와 `packages/core`, `packages/contracts`, `packages/runtime`, `packages/storage`, `packages/testkit`으로 정리합니다. core 내부에 조직·에이전트·승인·작업·연구·협력·기억·예산·보고의 기능 단위를 배치하고 UI는 계약을 통해 접근하는 방향입니다. 사용 언어·프레임워크·DB·프로세스 분리 결정은 초기 구조 문서와 기반 구현 이슈에서 기록합니다.

소스에 포함할 프로필 **템플릿**과 실행 때 생기는 조직·작업자별 실제 프로필·기억·세션·로그는 분리해야 합니다. 뒤의 실행 데이터는 기본 Git 추적 대상에서 제외합니다. 이 문서는 메모리 기술 선정이나 저장 스키마 결정을 대신하지 않습니다.

## 검증 결과와 한계

- 공개 공식 저장소 여섯 개에서 metadata → commit → tree 순으로 조회했으며 모든 recursive tree가 완전 응답이었습니다.
- 대표 파일 44개를 고정 SHA raw URL로 조회했습니다. 응답은 모두 성공했으며 외부 설치·코드 실행은 하지 않았습니다.
- `python3` 검증 스크립트에서 문서의 34개 고정 source 링크마다 SHA 일치·tree 경로 존재·다운로드된 파일 존재를 assert로 확인했습니다. 출력은 `downloaded_files 44`, `fixed_source_links_checked 34`, `complete_trees 6`, `validation passed`이며 종료 코드는 0입니다. 이 검증은 자료 연결 확인이며 제품 기능 테스트가 아닙니다.
- shell의 `python` 명령이 없어 최초 조사 명령이 종료 코드 127로 실패했습니다. `python3`으로 바꿔 같은 조회를 성공시켰습니다.
- 라이선스 metadata와 실제 파일이 다른 Paseo 사례를 확인하여 실제 LICENSE로 정정했습니다.
- 디렉토리 존재는 역할 배치의 근거이며 동작 성공의 근거가 아닙니다. 에이전트 pause/resume, 승인 강제, 조직 격리, heartbeat 의미와 장애 복구는 후속 기능별 조사·실행 검증이 필요합니다.
- 이번 조사에서 제품 코드를 복사하거나 메모리 기법을 조사하지 않았습니다. 실제 기능 구현 전에 선택한 파일·버전·실행 계약을 다시 검토해야 합니다.

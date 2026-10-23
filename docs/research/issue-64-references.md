# issue-64 레퍼런스 조사: Role·Soul·Skill 편집과 revision

조사일: 2026-10-23. 대상: [#64](https://github.com/babo-jeonguk/BaboJUBot/issues/64). 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/issue-64/`(git 무시). 제품 코드·테스트·설정은 변경하지 않는다.

이슈 기록: [조사 receipt](https://github.com/babo-jeonguk/BaboJUBot/issues/64#issuecomment-6347651179). 게시 후 문서의 권고·열린 결정과 대조했다.

## Brief

- 구현할 문제: 사용자가 에이전트 소유 Role·Soul·Skill 사본을 편집하고, 저장마다 번호·편집자·시각·본문의 revision, Event, Lead 깨우기를 남긴다. 다음 실행 시도에는 새 지침을 주고 bundle이 달라지면 새 세션으로 시작한다. revision 목록과 과거 본문은 읽기 전용이다.
- 동종 문제: 소유 범위가 있는 구성 문서의 불변 변경 이력과 실행 시점 내용 스냅샷을 함께 관리하는 메커니즘.
- 고정된 결정: #54의 `instruction_copies`는 에이전트별 독립 사본이다. 다른 에이전트와 라이브러리는 바꾸지 않는다. 판 1 편집자는 사용자이고 사본 편집 조직 도구는 없다. 다른 조직 ID는 없는 것처럼 거부하고 최종 완료·중단 조직의 편집을 거부한다. 되돌리기·diff·Lead 편집 도구·timeout은 제외한다. [#50 배치 C](https://github.com/babo-jeonguk/BaboJUBot/issues/50#issuecomment-6161637737)의 에이전트 상세 페이지와 안내를 유지한다.
- 연결 이슈: parent [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49)는 진행 중이고 blocker [#54](https://github.com/babo-jeonguk/BaboJUBot/issues/54)는 조회 시 완료 상태다. 초기 승인·최종 완료·조직 분리는 제품 코드로 강제한다. 실제 모델 호출·계정·비용은 이번 조사에 없다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 현재 사본과 번호·편집자·시각·과거 내용을 어떻게 원자적으로 남기는가? 초기 revision과 동일 내용 저장은? | #64 본문 사용자 편집, AC1 | 저장 Source Recon + persistence/recovery |
| Q2 | 오래된 편집·동시 저장·교차 조직 참조·종료 조직 쓰기를 어디서 거부하고 Event/Lead 깨우기와 묶는가? | #64 AC1/2/4/5, AGENTS 제품 불변 조건 | 격리 Source Recon + adversarial scenario + 독립 SQL 실험 |
| Q3 | 진행 중 실행·bundle 변경·동일 내용 재저장·A→B→A를 다음 실행 세션에 어떻게 연결하는가? | #64 AC3, ADR-0001·구조 실행 시도 seam | 실행 Source Recon + runtime/failure |
| Q4 | 편집·저장·취소·이력 선택을 로딩·실패·충돌·좁은 폭·실시간 갱신에서 어떻게 구분하는가? | #64 화면 범위/AC6, #50 결정 | Surface Capture + Behavioral/Source Recon |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [#54 사본·bundle 권고](issue-54-references.md#결정-권고) | 독립 사본, 원본 provenance, 전체 bundle 내용 버전과 entry 해시 구분 | 기존 E를 새 E로 옮기지 않음. Paperclip 이전 `c9669a6…`와 이번 ref의 파일별 blob 비교는 `recon/paperclip.md`, `recon/editor-paperclip.md`. UI 본문 변경, UI 테스트 동일; 이번 원문 재열람 |
| [#53](issue-53-references.md#구현-참고)·[실행 모델](agent-runtime-models.md#핵심-판단) | 세션 재개와 실행 시도 스냅샷의 배경 | 현행 core/harness·run, db/runs의 실제 계약을 다시 읽고 제한 실행(E13–E15). 이전 조사로 현행 동작을 대신하지 않음 |
| [#50](issue-50-references.md#결정-권고)·[Paperclip 대시보드](paperclip-dashboard.md) | scope·탭 배경 | 배치 수치는 #50 확정 댓글을 우선. 과거 캡처를 이번 편집 화면의 실행 근거로 쓰지 않음 |
| [#56](issue-56-references.md#구현-참고) | 사용자 편집+Event+Lead 깨우기의 인접 패턴 | 현행 db/research-map.ts 재열람. 지도 편집의 초기 승인 뒤 gate·동일 값 no-op를 사본 편집에 그대로 적용하지 않음 |
| [#57](issue-57-references.md)·[#58](issue-58-references.md)·[#59](issue-59-references.md)·[#60](issue-60-references.md) | 종료·승인 정책·일시정지·복구의 경계 | 이번 revision 저장 방식의 직접 근거로 재사용하지 않음. 현행 조직→에이전트 잠금 순서와 local trusted 사용자 API 전제 유지 |
| 나머지 research 문서와 기존 cache | 후보 탐색, 소스·실행 도구 위치 | `brief.md`에 목록과 재사용 판단. 별도 저장/기억 엔진·자체 agent loop 채택 근거로 사용하지 않음 |

## 레퍼런스

관점별로 3라운드 검색했다. agent/prompt 구성에서는 파일 기반 현재값·불변 번호 이력·가변 label의 세 유형, 동시성에서는 조건부 저장·원자적 이력·동일 값 단축과 검사 순서, UI에서는 draft/base·이동 보호·읽기 전용 선택의 패턴을 얻었다. 마지막 라운드는 이 유형의 변형을 더했지만 새 질문·실패 부류를 추가하지 않아 saturation으로 판단했다. 이는 공개 자료의 제한된 탐색 결과이며 전수조사는 아니다. 중복 제거한 후보는19개다. 전체 후보·검색 경로·실행 경로·선정 이유는 `candidates.md`와 `notes/`에 보존한다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Paperclip 서비스 | OSS agent 운영 | `def4726bea0e3b340457100038d80ca55c2b7d4f` | MIT | 소스 | 같은 지침 사본 문제. 최신은 revision을 남기지 않는 중요한 반례 |
| Paperclip 편집 UI | 같은 제품의 별도 고정 ref | `78b833c4958465b5e345b0e337018011b00dab72` | MIT | 소스·제한 실행 | dirty/base·충돌 보존 테스트와 legacy 이력 renderer. 최신 backend와 같은 배포 조합이라고 주장하지 않음 |
| Langfuse | OSS prompt 관리 | `5264b13ee5d2ccd9424dfc4e721a6256e1e09b87` | 조사 경로 MIT Expat, ee 별도 | 소스 | 번호별 내용·편집자·시각, unique 충돌과 commit 뒤 오류 처리 |
| Grafana Unified Storage SQL 경로 | 인접 구성 저장 엔진 | `ffb93a072eac205acbfd47f1c8868bcf8e4b07ca` | AGPL-3.0 | 소스 | 범위+이전 버전 조건 UPDATE와 이력 INSERT의 transaction. dashboard 구형 저장 경로와 구별. 이 SQL 경로에는 retiring 주석이 있어 기본 backend라고 일반화하지 않음 |
| HTTP RFC 9110 | 표준 | §13.1.1 | 명세 | 문서 | If-Match의 강한 비교와 조건 불일치 처리. 인증·격리를 대신하지 않음 |
| CodeMirror 공식 readonly 예제 | 편집기 부품 | 배포 SHA 미공개, 2026-10-23 확인 | 코드 도입 없음 | 공개 실화면 실행 | 읽기 전용이어도 focus·선택 가능. 편집기 라이브러리 도입 권고는 아님 |

코드 복사 권고 없이 설계만 참고한다. Paperclip 컴포넌트는 조사용 `/tmp` 하네스에만 원문·LICENSE를 보존했다. 제품으로 복사할 경우 해당 SHA의 header·LICENSE·NOTICE·의존성 및 AGENTS의 출처 고지 규칙을 별도로 적용해야 한다.

## 근거

소스 링크는 고정 SHA다. 테스트를 읽은 사실은 실행으로 세지 않는다. 메인이 아래 결정에 쓰는 원문을 다시 열었으며 일치·보정 결과는 `main-verification.md`에 남긴다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | Paperclip의 현재 managed 파일이 원본이고 새 편집은 revision/head 행을 만들지 않는다. 예전 revision API는 호환성용이다 | [legacy 설계 설명](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/doc/agent-instruction-revisions.md#L1-L15) | 문서 주장 |
| <a id="E02"></a>E02 | 파일 저장은 owner bound lock 안에서 현재 hash와 baseHash를 비교해 충돌을 거부한다. 동일 내용은 baseHash 비교 전에 처리하며 파일 쓰기와 SQL 감사는 별도 저장 매체다 | [scope lock](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/server/src/services/agent-file-store.ts#L181-L190) · [agentFileStore.write](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/server/src/services/agent-file-store.ts#L215-L240) | 소스 확인 |
| <a id="E03"></a>E03 | Langfuse Prompt는 project/name/version unique와 createdBy/createdAt/content를 갖고, createPrompt는 최신 번호+1로 새 행을 넣는다. labels/tags는 이전 행도 갱신하므로 모든 메타데이터까지 불변이라고 일반화하지 않는다 | [Prompt](https://github.com/langfuse/langfuse/blob/5264b13ee5d2ccd9424dfc4e721a6256e1e09b87/packages/shared/prisma/schema.prisma#L880-L906) · [createPrompt](https://github.com/langfuse/langfuse/blob/5264b13ee5d2ccd9424dfc4e721a6256e1e09b87/web/src/features/prompts/server/actions/createPrompt.ts#L111-L241) | 소스 확인 |
| <a id="E04"></a>E04 | createPrompt action은 번호 unique P2002를 충돌 오류로 바꾸고, commit 뒤 cache/event 오류는 기록하고 저장 결과를 반환한다. 라우터 전체는 후속 auditLog await가 있어 같은 보장을 일반화하지 않는다. 충돌 테스트는 $transaction을 mock reject한다 | [conflict·side effects](https://github.com/langfuse/langfuse/blob/5264b13ee5d2ccd9424dfc4e721a6256e1e09b87/web/src/features/prompts/server/actions/createPrompt.ts#L225-L297) · [TRPC test](https://github.com/langfuse/langfuse/blob/5264b13ee5d2ccd9424dfc4e721a6256e1e09b87/web/src/__tests__/server/prompts-trpc.servertest.ts#L93-L124) | 소스 확인 |
| <a id="E05"></a>E05 | Grafana UPDATE는 group/resource/namespace/name/previousRV 조건을 모두 사용하고 영향 행 수를 검사한다. 현재값 수정과 history INSERT는 같은 transaction callback에 있다 | [SQL](https://github.com/grafana/grafana/blob/ffb93a072eac205acbfd47f1c8868bcf8e4b07ca/pkg/storage/unified/sql/data/resource_update.sql#L1-L14) · [backend.update](https://github.com/grafana/grafana/blob/ffb93a072eac205acbfd47f1c8868bcf8e4b07ca/pkg/storage/unified/sql/backend.go#L988-L1054) · [checkConflict](https://github.com/grafana/grafana/blob/ffb93a072eac205acbfd47f1c8868bcf8e4b07ca/pkg/storage/unified/sql/backend.go#L1109-L1122) | 소스 확인 |
| <a id="E06"></a>E06 | RV manager의 batch는 transaction으로 현재값·이력 버전을 함께 반영하며 callback 오류는 rollback한다. history INSERT 실패 테스트는 rollback과 version 0을 기대한다 | [execBatch](https://github.com/grafana/grafana/blob/ffb93a072eac205acbfd47f1c8868bcf8e4b07ca/pkg/storage/unified/sql/rvmanager/rv_manager.go#L298-L389) · [WithTx](https://github.com/grafana/grafana/blob/ffb93a072eac205acbfd47f1c8868bcf8e4b07ca/pkg/storage/unified/sql/db/service.go#L116-L138) · [test](https://github.com/grafana/grafana/blob/ffb93a072eac205acbfd47f1c8868bcf8e4b07ca/pkg/storage/unified/sql/backend_test.go#L385-L441) | 소스 확인 |
| <a id="E07"></a>E07 | Grafana 동일 bytes 업데이트는 RBAC를 검사한 후 RV를 올리지 않고 반환한다. stale RV의 다른 bytes는409, 동일 bytes는 RV 불변인 테스트가 있다 | [noop guard](https://github.com/grafana/grafana/blob/ffb93a072eac205acbfd47f1c8868bcf8e4b07ca/pkg/storage/unified/resource/server.go#L1425-L1449) · [tests](https://github.com/grafana/grafana/blob/ffb93a072eac205acbfd47f1c8868bcf8e4b07ca/pkg/storage/unified/resource/server_test.go#L503-L569) | 소스 확인 |
| <a id="E08"></a>E08 | If-Match는 대상 validator를 강하게 비교하며, 불일치하면 원칙상 변경하지 않고412로 응답한다. 이미 적용됐다고 검증할 수 있는 예외에는 성공 응답이 가능하다 | [RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1) | 문서 주장 |
| <a id="E09"></a>E09 | Paperclip UI는 query의 현재값과 draft/base를 분리한다. 저장에 pinned base를 보내고 성공/취소 때 초기화한다. 편집 중 poll을 멈추고 충돌 오류에서 draft를 보존하는 mock 테스트가 있다 | [save/cancel](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/pages/AgentDetail.tsx#L2559-L2652) · [poll](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/pages/AgentDetail.tsx#L2303-L2346) · [tests](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/pages/AgentDetail.instructions.test.tsx#L468-L525) | 소스 확인 |
| <a id="E10"></a>E10 | legacy History는 open 시 조회, 별도 로딩·오류·pagination과 과거 본문 pre를 제공한다. 현 agent_files는 History를 숨긴다. 번호 대신 짧은 UUID를 쓰고 diff/restore가 있으므로 #64 계약 그대로는 아니다 | [InstructionHistory](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/components/InstructionHistory.tsx#L22-L145) · [render condition](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/pages/AgentDetail.tsx#L3125-L3136) | 소스 확인 |
| <a id="E11"></a>E11 | route 이동 가드는 있지만 file 선택은 base refs를 지우며 해당 callback에 dirty 검사가 없다. 뒤의 version effect는 base가 없으면 draft를 지울 수 있다. 탭 전환 손실 가능성은 이 경로에서 도출한 추론이고 실행 재현은 아니다 | [navigation](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/pages/AgentDetail.tsx#L1088-L1162) · [reset](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/pages/AgentDetail.tsx#L2275-L2282) · [select](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/pages/AgentDetail.tsx#L2951-L2967) · [effect](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/pages/AgentDetail.tsx#L2524-L2539) | 소스 확인 |
| <a id="E12"></a>E12 | CodeMirror 공식 예제의 focus 가능한 readonly 영역에서 입력 후 내용 불변, Ctrl+A로 본문 선택을 확인했다. desktop/390px 캡처에 선택 영역이 보인다 | [실행 예제](https://codemirror.net/examples/readonly/), `probes/capture-ui.mjs`, `captures/captures.md` | 실행 확인 |
| <a id="E13"></a>E13 | 독립 PG 모형에서 동시 저장 중 하나 충돌, 현재값/revision/Event/wake rollback, 복합 귀속 FK, 사본 독립, 종료 거부, 응답 유실 재시도, 동일 내용 이력과 내용 버전 분리를 확인했다. 제품·upstream API 검증이 아니다 | `probes/revisions-pg.mjs`, `revisions-pg-log-final.txt`; Node24.21.0/PG18.4, 전체 E14/E15 포함10건·35 assertions | 실행 확인(제한) |
| <a id="E14"></a>E14 | 현행 instructionsBundleVersion/planRunStart를 직접 호출했다. 같은 내용은 같은 버전·이전 session, 다른 내용은 새 session. A→B→A 중 B 실행이 없으면 기존 A session을 재개한다 | 현행 [harness](../../packages/core/src/harness.ts)·[run](../../packages/core/src/run.ts), 동일 probe. 로컬 기준 commit `b0ea70e30931d357454e2e6a9bcb469ae81b0f61` | 실행 확인(순수 함수) |
| <a id="E15"></a>E15 | 현행 claimNextRun은 조직 FOR SHARE→agent FOR UPDATE 뒤 사본을 읽고 그 값으로 bundle과 runtime 요청을 구성한다. 원본 provenance sourceDigest는 내용과 별도다 | 현행 [db/runs](../../packages/db/src/runs.ts) `claimNextRun`·`selectInstructions`, [schema](../../packages/db/src/schema.ts) `instructionCopies`; 같은 commit | 소스 확인 |
| <a id="E16"></a>E16 | 고정 UI SHA의 InstructionHistory 원문을 합성 API와 native Button adapter로 띄워 History→과거 revision 선택→읽기 전용 pre, 로딩·오류·빈 목록을 조작했다. 빈 목록에는 별도 설명이 없었다. 1440/390px 포함5캡처 | `selfhost/history-ui.md`, `probes/surface-capture-log.json`; 원문 SHA256 일치. restore 미클릭, theme 없음 | 실행 확인(제한) |

근거 16개: 실행4·소스10·문서2. E13/E14는 같은 10건 실행의 다른 관찰이므로 검사 수를 중복 합산하지 않는다. E11의 위험과 아래 권고는 근거에서 도출한 판단이다.

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 사본 신원·저장 revision·bundle 내용 버전 분리 | E01–E04,E14,E15 | filesystem 현재값 / prompt 번호 이력 / agent 사본 | 감사와 실행 내용의 서로 다른 질문에 답함 | 번호나 sourceDigest를 내용 버전으로 오용; 같은 내용 저장·ABA 혼동 |
| <a id="P02"></a>P02 | 범위+expected revision 검사와 원자적 append | E03–E08,E13 | scope/RV CAS, unique 충돌, HTTP 조건부 쓰기 | 오래된 탭의 덮어쓰기·부분 저장 방어 | unique만으로 stale overwrite 방지 불가, hash-only ABA, commit 뒤 필수 Event 손실 |
| <a id="P03"></a>P03 | 실행 시점 지침 스냅샷과 세션 비교 | E14,E15 | 현재 hash와 이전 run hash 비교 | 진행 중 실행의 맥락 유지, 다음 실행에 최신 내용 | 실제 주입값과 해시를 따로 읽으면 불일치; 모든 편집을 session reset으로 간주하면 기존 계약 확대 |
| <a id="P04"></a>P04 | 현재값·draft/base·선택한 과거 이력의 별도 상태 | E09–E12,E16 | rich editor / readonly pre / focusable readonly 부품 | 실패·실시간 갱신에도 draft 보존, 과거 내용 오저장 방지 | 탭·agent 전환 손실, mount 정규화 false dirty, 빈 이력과 실패 혼동 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 기존 instruction_copies를 현재 사본으로 유지하고 copy별 단조 revision 번호·편집자·시각·전체 본문의 append 이력을 둔다. 별도 revision ID와 `(copy, 번호)` unique를 두고 source/sourceDigest는 복사 출처로 보존 | P01,P02; #64 AC1/2 | 파일/Git 이력 엔진 도입 없이 PG transaction과 과거 읽기 가능. 최초 baseline 번호/이관은 열린 결정 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | 편집 요청에 사본별 expectedRevision을 필수로 보내고 서버에서 현재 번호와 비교한다. 조직 범위·agent 소유·존재와 생애주기를 검사한 뒤 충돌을 거부한다. revision 생성의 unique는 마지막 방어선 | P02; E07/E08/E13 | 내용 hash만으로는 ABA 편집 순서를 검출하지 못함. body의 actor/org 값으로 신원을 정하지 않고 기존 사용자 명령 경로에서 owner를 기록. JSON expectedRevision이면409, 실제 If-Match면412 의미를 따른다 | Q2 |
| <a id="D03"></a>D03 | 변형 채택 | 조직 행 잠금 아래 현재 사본 수정·revision 추가·해당 조직 Event·편집 사유/사본/revision을 가진 Lead wake를 한 transaction으로 저장한다. 조직→agent/copy 순서를 기존 claim과 맞추고 EventHub publish/kick은 commit 뒤에만 한다 | P02,P03; E05/E06/E13/E15 | 편집과 claim/최종 완료의 선후를 명확히 함. Event/필수 wake를 best-effort postcommit에 두지 않음. revision의 org/agent/copy 연결은 복합 FK나 동등한 DB 제약으로 방어 | Q1,Q2,Q3 |
| <a id="D04"></a>D04 | 채택 | 전체 사본의 경로·내용 기반 bundle 계산과 현재 claim 스냅샷을 재사용한다. 진행 중 run에는 편집 내용을 소급 주입하지 않는다. 다음 claim의 bundle이 이전 run과 다르면 previous session 없이 실행한다 | P01,P03; ADR-0001; #64 AC3 | revision 번호·편집자·시각으로 bundle hash를 바꾸지 않음. 다른 에이전트·library·진행 중 runtime 값은 불변. ABA의 엄격 초기화 요구는 별도 열린 결정 | Q3 |
| <a id="D05"></a>D05 | 변형 채택 | 성공으로 수락한 저장에는 #64의 “저장마다” revision·Event·Lead wake를 만든다. UI는 변경 없는 저장을 보내지 않을 수 있지만 API 동일 내용 수락을 조용한 no-op로 바꾸지 않는다. 이력 번호와 bundle 동일 여부는 별개 | P01,P02; E07/E13/E14; #64 | Grafana/Paperclip no-op를 그대로 채택하지 않음. 응답 유실 뒤 같은 expectedRevision 재시도는 충돌+조회로 확인; 새 번호를 자동 재시도로 계속 발행하지 않음 | Q1,Q2,Q3 |
| <a id="D06"></a>D06 | 변형 채택 | 현재 persisted 값/번호와 local draft/base를 분리하고, 저장 실패·충돌·실시간 invalidation에서 draft를 보존한다. 저장 중 중복 제출을 막고 서버 성공 뒤 current·revision 목록을 갱신한다. 취소는 로컬 draft 폐기이며 revision/Event/wake를 만들지 않는다 | P04; E09 | 같은 문서 최신값 재조회가 편집 내용을 덮지 않게 한다. 충돌 때 최신값 확인과 draft 유지를 제공하되 diff/자동 merge 기능으로 확대하지 않음 | Q4 |
| <a id="D07"></a>D07 | 변형 채택 | 별도 agent 상세 Role·Soul·Skill 탭에 이 agent 전용 사본 안내와 편집/저장/취소, 번호·편집자·시각 목록을 둔다. 과거 선택은 읽기 전용 본문과 현재 보기 복귀만 제공한다. 파일·agent·조직 전환과 Back/reload 각각에서 dirty 손실을 막는다 | P04; E10–E12/E16; #50 | current/history query는 org+agent+copy+revision 범위. 빈/로딩/오류/404/종료로 편집 불가를 구별. 390px 실제 제품 레이아웃 검증 필요; harness theme를 배치 근거로 쓰지 않음 | Q4 |
| <a id="D08"></a>D08 | 배제 | filesystem 현재값만 유지, shared role 원본 수정, 가변 latest/production label 배포, 이력 자동 삭제, diff/restore/Lead 편집 도구·새 agent loop를 이번 범위에 들이지 않음 | P01–P04; E01/E03/E10; #64/ADR | #64의 사본 독립·저장 이력·다음 실행 반영과 맞지 않거나 명시 범위 밖. 원본/도구 권한을 prompt 문구로 강제하지 않음 | Q1,Q2,Q3,Q4 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 최신 Paperclip이므로 지침 revision도 신규 저장된다고 가정 | E01/E10 | 현행은 파일이 원본이며 UI History는 legacy. #64에 필요한 불변 저장 이력과 다름 |
| MAX(version)+1 및 unique만으로 오래된 편집까지 해결 | E03/E04 | 번호 중복 방어와 사용자가 편집을 시작한 기준 검증은 별개 |
| 내용 같으면 권한/종료/기준 번호 확인 전에 성공 반환 | E02/E07 | 쓰기 정책 검사 우회·묵시 중복 성공. #64는 저장마다 이력 계약이고 명시 실패/조회 복구가 더 단순 |
| DB transaction이면 파일 쓰기까지 rollback된다고 가정 | E02/E05/E06 | 저장 매체가 다름. 이번에는 이미 DB에 있는 사본을 편집하므로 불필요한 이중 원본을 만들지 않음 |
| 모든 화면 갱신을 draft 초기화 또는 파일 전환 보호로 일반화 | E09/E11 | poll 억제·route 가드가 파일/agent/조직 전환 전체를 보장하지 않음 |

## 구현 참고

[구조](../architecture.md#패키지-구성)·[코드 지도](../agents/code-map.md)를 따른다. `packages/contracts`는 편집/조회/revision·Event·wake 계약, `packages/core`는 actor·단계·revision 계획과 기존 bundle 규칙, `packages/db`는 migration·범위 조회·원자적 저장, `apps/server`는 사용자 API와 commit 뒤 알림, `apps/web`은 draft/이력/실시간 갱신을 맡는다. 기존 `db/harness.ts`, `core/harness.ts`·`run.ts`, `db/runs.ts`·`schema.ts`, `server/app.ts`·`dispatcher.ts`, `web/agents.tsx`·`api.ts`·`live-events.ts`가 출발점이다. 실제 확장 파일 배치는 구현 시 정하며 runtime은 DB·웹 편집기에 의존하지 않는다.

- 권고 요약: 사본 단위 optimistic revision과 불변 전체 본문 이력을 한 transaction으로 저장하고 현재 내용 기반 bundle/claim 경로를 재사용한다. 원본 library와 초기 승인 snapshot은 편집 대상이 아니다.
- 사용자 API 신뢰 경계는 현행 local trusted 전제를 유지한다. 에이전트 token의 조직 도구 목록/dispatch에는 편집 기능을 추가하지 않는다. 같은 OS 사용자의 임의 HTTP/DB 접근 격리는 #64 연구만으로 해결됐다고 주장하지 않는다.
- Skill 편집도 기존 UTF-8·크기·경로·frontmatter 계약을 재사용할지 구현 전에 명시한다. path/종류/복사 출처를 자유 텍스트 본문과 함께 재지정하지 않는다. 빈 Role/Soul과 필수 metadata가 있는 Skill의 유효성을 구별하며 실패는 draft를 보존한다.
- Lead 자신 편집도 Lead wake 한 건을 만들되 claim은 기존 실행 슬롯·생애주기 규칙을 따른다. 일시정지 중 저장된 wake는 재개 뒤 처리한다. #56의 “초기 승인 뒤” 지도 편집 gate를 지침 편집에 복사하면 목표 설정 중 Lead 사본 편집을 과도하게 막으므로 #64가 명시한 최종 완료·중단 거부를 기준으로 검토한다.

아래는 **구현 검증 제안**이다. 이번 조사에서 제품 테스트로 실행한 것이 아니다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | Role/Soul/Skill 각각 편집 → 새 번호·owner·서버 시각·전체 본문, current/revision/Event/Lead wake가 함께 commit. 중간 오류 → 전부 rollback | D01–D03 |
| V02 | 같은 Role worker A/B와 library → A만 편집 → B·library·복사 출처 digest 불변. A 다음 bundle만 변경 | D01,D04 |
| V03 | A org URL에 B org agent/copy/revision ID·없는 ID·agent와 불일치 copy ID → 같은404, 이력 정보·번호 노출과 쓰기 없음 | D02,D07 |
| V04 | 완료·중단 뒤 저장·동일 내용 저장 → 거부, revision/편집 wake/성공 Event0. 단계 전이와 동시 저장 → 조직 잠금 순서에 따른 한 가지 결과 | D02,D03,D05 |
| V05 | 같은 expectedRevision 두 탭 동시 저장 → 하나 성공·하나 충돌, draft 보존. 응답 유실 재시도 → 추가 부작용0·조회로 성공 확인 | D02,D03,D06 |
| V06 | run 진행 중 사본 편집 → 기존 instructions/version/session 불변, 다음 run만 새 본문/version·previousSession 없음. 다른 agent run/session은 불변 | D03,D04 |
| V07 | 동일 내용 수락 → 저장 revision은 증가·bundle은 동일. A→B→A(중간 run 있음/없음) 각각 확정한 세션 규칙 확인 | D04,D05 |
| V08 | 이력 목록→과거 선택 → 번호·편집자·시각·원문 읽기 전용. current 편집과 혼동0, restore/diff mutation0, agent 도구 목록과 직접 dispatch에 편집 없음 | D07,D08 |
| V09 | 편집→저장/취소/오류/충돌, dirty 중 Event 도착·다른 파일/agent/org·Back/reload → draft 정책대로 보존 또는 명시 폐기. A→B 전환 후 늦은 A 응답이 B에 노출되지 않음 | D06,D07 |
| V10 | 다른 탭 저장→읽기 화면과 revision 목록 실시간 갱신. desktop/390px·키보드에서 저장/취소/과거 보기 접근, 로딩·빈·오류·404·종료 불가 구별 | D06,D07 |
| V11 | 잘못된 Skill frontmatter·초과 bytes·본문과 다른 path/actor 위조 → 계약대로 거부·draft 유지·부분 revision0 | D01,D02,D06 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 최초 revision과 기존 데이터 | #64 | 추천: 현재 사본을 baseline revision1로 이관하고 최초 사용자 저장은2. 최초 내용이 복사/이관임을 기록하고 과거 편집자·시각은 꾸며내지 않음. 대안: 첫 편집 때 baseline을 함께 고정하되 편집 전 이력 조회 계약도 정의. sourceDigest를 현재 내용 digest로 덮어쓰지 않음(D01) |
| 같은 내용·ABA 세션 의미 | 사용자/#64 | 추천: 현행 내용 버전 비교 유지. 같은 내용 재저장은 세션 유지, B run 없이 A→B→A면 기존 A 세션 재개(E14). 대안: “이전 run 이후 어떤 편집이라도 새 세션”이면 bundle 내용 버전과 별도 edit generation을 도입하고 ADR/실행 계약을 먼저 합의. revision을 bundle hash에 섞는 방식은 기존 내용 기반 결정과 충돌 |
| dirty 상태에서 다른 파일·agent로 이동 | #64 | 추천: 저장/명시 폐기/계속 편집 선택으로 전환을 보호. 대안: copy별 draft를 유지하되 보존 범위·수명·새로고침 동작 명시. upstream file 선택 callback을 그대로 쓰지 않음(E11) |
| Skill 본문 편집의 유효성 | #64 | 추천: 라이브러리 로딩과 같은 필수 frontmatter/크기/경로 계약 검증. 대안: 자유 초안을 저장하되 실행 가능한 지침과 구별하는 모델은 이번 범위를 확대하므로 채택 전 별도 결정 |

이력 장기 보존/삭제와 export, 실제 Claude·ACP의 파일 주입/세션 교체, 사용자의 runtime 격리는 후속 범위다. 관련 이슈 번호를 확인하지 못한 항목에 임의 번호를 붙이지 않는다. #63은 구현 뒤 walking skeleton 통합 검증이며 이번 조사로 완료되지 않는다.

## 한계와 미확인

- 실행함: 독립 PG+현행 순수 함수 10건·35 assertions, 공식 CodeMirror readonly desktop/390px2캡처, 고정 Paperclip legacy 이력 renderer5캡처. 총7캡처를 메인이 직접 열었다. SQL 모형의 복합 FK/단계 검사·응답 유실 가정은 권고 메커니즘 검증이며 제품 API나 upstream 전체 실행이 아니다.
- Paperclip 제한 self-host: 원본 InstructionHistory 파일 SHA256 일치, 합성 API·native Button adapter·theme 없는 실행이다. selection/readonly/loading/error/empty 상태까지만 근거이며 실제 agent 편집→저장→서버 이력 생성·세션/권한·완성된 좁은 폭 배치는 미확인이다. diff가 보이는 원본 UI지만 diff/restore 검증·도입은 하지 않았다. 빈 이력에는 별도 문구가 없다는 반례를 기록했다.
- Langfuse demo는 가입 화면으로 이동하여 로그인하지 않았다. Grafana play는 브라우저 body가 비어 이력 화면을 관찰하지 못했다. CodeMirror web open403은 실제 브라우저 재확인으로 해소했다. Paperclip/Langfuse/Grafana 전체 self-host·upstream tests·실제 모델/provider·API/E2E·강제 server crash 복구·filesystem I/O race는 미실행이다.
- SQL 최초 sandbox 실행은 빈 로그로 검증 불가, loopback 허용 환경에서 재실행했다. 첫 pure-function probe는 시계 인자를 잘못 전달해 실패했고 `now()`로 수정 후 최종10건이 통과했다. UI 서버 첫 기동은 read-only mount에 Vite cache를 쓰려다 실패했고 cache를 `/tmp`로 옮겼다. Grafana PR 웹 열람 cache miss는 worker가 보관한 공식 API 본문으로 보완했다. 환경/하네스 실패를 제품 기능 부재로 사용하지 않는다. 일회용 PG와 UI/browser 컨테이너는 정리했다.
- 공개 CodeMirror 배포 SHA는 미공개, UI ref와 backend HEAD는 서로 다르다. upstream 변경과 구현 시점 라이선스·NOTICE·계약을 재확인해야 한다. 제품 코드·테스트·설정 변경·커밋·push·PR·실제 연구 데이터/자격 증명 사용은 없다. 이 문서는 구현 변경과 함께 검토·커밋되도록 남긴다.

# issue-141 레퍼런스 조사: 실행 시도 종료 저장과 후속 효과 경로 통합

#141의 종료 저장·후속 효과·시작 복구 경계를 조사한다. 현행 요구는 [#141](https://github.com/babo-jeonguk/BaboJUBot/issues/141), 구조는 [architecture](../architecture.md)가 기준이다.

조사일: 2026-11-10. 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 제품 코드·테스트·설정 변경과 커밋은 하지 않았다.

## Brief

- 구현할 문제: 정상 종료와 서버 재시작 중단의 저장 결과를 기존 Stored/AfterCommit 경로로 전달하면서 원자성·중복 안전성·재시도·전체 복구 저장 완료 장벽을 보존한다.
- 동종 문제: 영속 종료의 단일 확정과 commit 뒤 재시도 가능한 실행 촉진을 분리하는 메커니즘.
- 고정된 결정: core 종료 판단 / DB transaction / dispatcher 프로바이더 호출·동일 결과 저장 재시도 / server AfterCommit 효과 적용. 초기 승인·최종 완료·조직 경계·사용자 취소 우선·세션 세대·일시정지 admission 유지. 새 budget adapter·영속 outbox·정확히 한 번 전달·거대 복구 transaction·실제 모델 호출 제외.
- 이슈 조회: 댓글 없음, parent 없음(404), blocker 목록 비어 있음. 로컬 기준 SHA `c88a98b58284a38bdadf7eff7aafa0219005371c`.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 종료 상태·사용량·세션·Event 원자성과 동일 결과 재저장을 유지하면서 중복 종료의 촉진을 어떻게 반환하는가? | #141 불변 조건·중복/응답 유실 | Source Recon + runtime/failure |
| Q2 | 저장 성공 뒤 효과 실패를 어떻게 격리하고 기존 순서·진단·나머지 효과를 보존하는가? | #141 후속 효과·Testing Decisions | Source Recon + Behavioral Recon |
| Q3 | 일부 복구 저장 성공 뒤 지연/실패해도 전체 저장 전 실행을 차단하는가? | #141 서버 시작 복구 순서 | Source Recon + persistence/recovery |
| Q4 | 촉진은 첫 조회까지만 기다리고 자기 pump 완료를 기다리지 않게 하는가? | #141 중복·효과 실패와 대기 범위 | Source Recon + runtime/failure |
| Q5 | 취소·세션 세대·조직/승인 경계를 유지하며 예산 판단은 어디에 남기는가? | #141 불변 조건·판4 확장 위치 | Source Recon + adversarial scenario |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [#60 D05/D07](issue-60-references.md#결정-권고) | startup 선복구·입력 복원·새 실행 권한 | 과거 구현 관찰은 현행으로 간주하지 않고 현재 runs/core/dispatcher를 다시 읽음(E01–E04). 옛 실행 증거 재사용 안 함 |
| [#59 구현 참고](issue-59-references.md#구현-참고) | 취소 우선·잠금·pause 의미 | 현재 core/run·DB 잠금·pending 조회 대조(E01/E04) |
| [#61 근거](issue-61-references.md#근거) | 영속 outbox와 휘발 후속 효과의 보장 차이 | 외부 옛 SHA 소스 재사용 안 함. 기존 알림 outbox를 이번 효과 지시와 동일시하지 않음 |
| [#1](issue-1-references.md#결정-권고)·[#62](issue-62-references.md#결정-권고) | Run·Task·연구 완료·running의 구별 | 용어 맥락만 재사용 |

#125는 프로바이더 background 실행 수명 조사로 이번 commit 뒤 효과와 다르므로 재사용하지 않는다. 로컬 캐시의 기존 조사도 후보 탐색 출발점일 뿐 이번 실행 근거로 세지 않았다.

## 레퍼런스

외부 후보 13행(관점 간 중복 포함, 고유 12종). 세 관점에서 병렬 조사했다. saturation은 질문 범위에서 마지막 라운드가 새 메커니즘을 추가하지 않았다는 뜻이며 전수조사 주장이 아니다.

| 관점 | 검색 확장과 종료 근거 |
|---|---|
| transaction callback | ORM 공식 API → 인접 transaction API → Celery 사용처·경량 ORM. 마지막 라운드는 commit 후 enqueue·기존 callback 패턴을 반복 |
| scheduler 완료·촉진 | queue 공식 문서 → ACK/알림 인접 사례 → 심볼·회귀 변경. 마지막 라운드는 저장 retry·촉진 signal·재실행의 기존 분류를 구체화 |
| startup 복구 | workflow/job engine → 영속 scheduler 시작 순서 → 다른 scheduler의 준비 장벽·테스트 대조. 상세는 후보 기록 |

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| BaboJUBot 현재 경로 | 내부 비교 기준 | `c88a98b58284a38bdadf7eff7aafa0219005371c` | MIT | 소스·실행 | 보존할 원자성·현재 실패 격리 공백 |
| Django | transaction hooks | 5.2.8 / `47fe39af56ecd0ad73b9c7562511015e96b91b80` | BSD-3-Clause | 소스·실행 | 개별 callback 격리와 진단 실패 반례 |
| BullMQ | 작업 큐 | `37445378a1a0e04283fdfffbd40453d7dcf03c47` | MIT | 소스 | 결과 보존 retry·완료 후 다음 조회·중복 완료 반례 |
| APScheduler | 영속 scheduler 개발판(master, 출시 버전 아님) | `05b4e2d69f89e3f8d87c6eec5df71ed1dd5705ec` | MIT | 소스 | 복구 완료 전 획득 차단·transaction 밖 발행(단일 복구 tx는 채택 안 함) |

Quartz Java(`741ccc3cff96a32e4ab07d69624eaaa534624245`, Apache-2.0)는 복구 후 unpause의 소스 비교 대상으로 읽었다. 같은 객체의 실패한 start 재시도 위험은 소스 추론에 그쳐 결정 근거에서 제외했다.

모두 설계 참고다. 외부 코드 복사나 패키지 채택 권고가 아니며, 복사하려면 해당 SHA의 header/NOTICE/의존성과 루트 고지를 별도로 확인한다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | finishRun은 조직→agent→running 행 잠금 뒤 상태·usage·세션·Event를 한 transaction에 기록한다. 중복은 undefined. interruptRun도 종료·wake 재대기·Event를 한 transaction에 저장한다. | [원문](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/db/src/runs.ts#L185-L311) | 소스 확인 |
| <a id="E02"></a>E02 | recoverInterruptedRuns는 실행 시도별 저장을 모두 마친 뒤 Event 배열을 반환한다. start는 그 뒤 publish·pending 조회·kick. 부분 commit을 거대 transaction으로 묶지 않아도 선저장 장벽이 있다. | [원문](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/db/src/runs.ts#L315-L333) | 소스 확인 |
| <a id="E03"></a>E03 | dispatcher는 pendingFinishes에 원래 결과를 보존하고 finish 성공 뒤 삭제한다. 현재 직접 publish·kickProvider를 수행한다. kick은 void, kickWaiting은 첫 조회만 기다리고 실패하면 별도 retry한다. | [원문](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/server/src/dispatcher.ts#L111-L265) | 소스 확인 |
| <a id="E04"></a>E04 | 취소 사유가 성공보다 우선하며 실패/취소 세션 보존·generation 불일치 stale·server_restart의 wake 복원/heartbeat 병합이 별도 순수 판단이다. | [원문](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/core/src/run.ts#L342-L470) | 소스 확인 |
| <a id="E05"></a>E05 | 공통 적용기는 workspace 준비만 catch한다. 나머지 publish/settings/cancel/resume/kick/provider 호출은 공통 catch 없이 순서대로 호출한다. | [원문](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/server/src/after-commit.ts#L21-L75) | 소스 확인 |
| <a id="E06"></a>E06 | 원본 after-commit.ts+fake 의존성 9case: 정상 순서, 6개 효과 예외 각각 reject·후속 호출 중단, refused 무효과 확인. fake의 첫 조회 반환 probe는 실제 dispatcher 교착 검사가 아니다. | 로컬 probe; Node 24.21.0 | 실행 확인 |
| <a id="E07"></a>E07 | Django on_commit은 tx 안에서 hook을 등록하고 commit 뒤 등록 순서로 실행한다. robust=True는 개별 Exception을 진단하고 다음 callback으로 간다. | [원문](https://github.com/django/django/blob/47fe39af56ecd0ad73b9c7562511015e96b91b80/django/db/backends/base/base.py#L727-L769) | 소스 확인 |
| <a id="E08"></a>E08 | Django 5.2.8 진단은 func.__qualname__을 직접 읽는다. 부분 적용 callable에서 진단 자체가 실패할 수 있다. 최신 전체 버전의 동작으로 일반화하지 않는다. | [원문](https://github.com/django/django/blob/47fe39af56ecd0ad73b9c7562511015e96b91b80/django/db/backends/base/base.py#L752-L769) | 소스 확인 |
| <a id="E09"></a>E09 | 원본 Django SQLite 4case: robust 예외 뒤 next 실행/DB1, nonrobust 예외 뒤 중단/DB1, partial+robust 진단 AttributeError/DB1, rollback 효과0/DB0. 모두 commit 전 효과0. 메인이 재실행했다. | 로컬 probe; Python 3.12.3·Django 5.2.8 | 실행 확인 |
| <a id="E10"></a>E10 | BullMQ processJob은 processor 결과를 받은 뒤 handleCompleted(result)만 retry closure로 넘긴다. 단 handleCompleted 안에는 emit도 있어 전체 함수를 저장 전용 경계로 복사하면 안 된다. | [원문](https://github.com/taskforcesh/bullmq/blob/37445378a1a0e04283fdfffbd40453d7dcf03c47/src/classes/worker.ts#L1097-L1121) | 소스 확인 |
| <a id="E11"></a>E11 | BullMQ Lua는 lock/active 검사에서 중복 완료를 거부한다. 완료 결과·stream Event 기록 뒤에만 다음 job fetch가 있다. 응답 유실 재시도 시 촉진까지 재실행된다는 근거가 아니다. | [원문](https://github.com/taskforcesh/bullmq/blob/37445378a1a0e04283fdfffbd40453d7dcf03c47/src/commands/moveToFinished-14.lua#L95-L219) | 소스 확인 |
| <a id="E12"></a>E12 | handleCompleted는 완료 저장 후 다음 job data를 반환한다. resume은 기존 작업 종료를 기다리는 main loop에 signal을 넣는다. 긴 작업 중 짧은 작업 완료를 assert하는 회귀 테스트는 읽었으며 미실행이다. | [원문](https://github.com/taskforcesh/bullmq/blob/37445378a1a0e04283fdfffbd40453d7dcf03c47/src/classes/worker.ts#L1171-L1200) | 소스 확인 |
| <a id="E13"></a>E13 | APScheduler _process_jobs는 reap_abandoned_jobs 뒤 task_status.started를 알리고 SchedulerStarted를 기다린 뒤 acquire loop에 들어간다. | [원문](https://github.com/agronholm/apscheduler/blob/05b4e2d69f89e3f8d87c6eec5df71ed1dd5705ec/src/apscheduler/_schedulers/async_.py#L1124-L1148) | 소스 확인 |
| <a id="E14"></a>E14 | SQLAlchemy datastore의 abandoned job 정리는 전체 대상 하나의 transaction 안에서 종료하고 events를 모은 뒤 transaction 밖에서 publish한다. #141 전체 대상 장벽을 자동 보장하는 라이브러리 계약으로 해석하지 않는다. | [원문](https://github.com/agronholm/apscheduler/blob/05b4e2d69f89e3f8d87c6eec5df71ed1dd5705ec/src/apscheduler/datastores/sqlalchemy.py#L1138-L1171) | 소스 확인 |
| <a id="E15"></a>E15 | 현재 app 시작은 steer·compaction 복구→dispatcher.start→compaction/readiness/heartbeat/notification 시작→channel 순이다. CompactionScheduler.recover는 recoverCompactions DB 호출만 한다. | [원문](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/server/src/app.ts#L1250-L1266) | 소스 확인 |
| <a id="E16"></a>E16 | 공식 Django 문서는 callback 예외가 commit을 되돌리지 않으며 robust=False는 후속 callback을 막는다고 설명한다. | [원문](https://docs.djangoproject.com/en/5.2/topics/db/transactions/#performing-actions-after-commit) | 문서 주장 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 결과 확정과 후속 촉진 분리 | E01/E03/E10/E11 | BullMQ 중복 완료 거부와 우리 중복 촉진 요구는 다름 | provider 결과 보존·중복 usage/Event 방지 | 중복 no-op에서 촉진까지 생략하면 빈 슬롯 방치 |
| <a id="P02"></a>P02 | 순서 유지 + 독립 효과별 예외 격리 | E05–E09/E16 | robust 정책이 명시돼야 함 | 이미 저장한 결과 보존·다음 효과 처리 | 진단 자체 실패·effect batch 일부 실패·무응답은 별도 문제 |
| <a id="P03"></a>P03 | 준비 완료 장벽과 실행 개시 분리 | E02/E13–E15 | APScheduler의 reap 범위와 우리 전체 running 범위는 다름 | 개별 tx를 유지하며 조기 실행 차단 | per-run after 적용·다른 timer 시작이 장벽 우회 가능 |
| <a id="P04"></a>P04 | 촉진 signal과 작업 완료 대기 분리 | E03/E12 | 프로젝트는 DB 첫 pending 조회만 await | 재진입·자기 pump 교착 방지 | drain/pump await를 추가하면 종료 경로가 자신을 기다림 |
| <a id="P05"></a>P05 | 영속 판단과 전달 보장 구별 | E01/E04/E07/E14 | 우리 effects는 휘발 지시, durable outbox 아님 | 현재 seam·불변 조건 유지 | commit 직후 crash 전달 공백은 남음 |

## 결정 권고

모든 행은 조사로부터의 권고/추론이다. #141에 이미 확정된 정책을 바꾸지 않는다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 정상/중단 종료를 기존 Stored/AfterCommit으로 반환. 새 종료는 Event+해제된 실제 run.provider의 providersFreed, 이미 종료면 Event 없이 같은 provider 촉진 지시를 반환할 수 있게 함. 존재하지 않는 run은 해제 근거로 취급하지 않음 | P01, #141 중복 계약 | provider는 변경된 agent 설정이 아니라 저장된 run에서 얻어야 옛 연결 슬롯 촉진 가능. 값·거부 union 모양은 기존 호출자와 결정 | Q1,Q5 |
| <a id="D02"></a>D02 | 채택 | pendingFinishes의 동일 결과 저장 retry와 후속 효과 적용을 분리. 저장 성공 뒤 효과 실패는 finish 재시도/실패 상태 저장/provider 재호출로 연결하지 않음 | P01/P02 | commit 응답 유실이면 같은 결과 저장 재호출 → 중복 기록 없이 providersFreed 다시 얻음. Event 재생성은 금지 | Q1,Q2 |
| <a id="D03"></a>D03 | 변형 채택 | 공통 AfterCommit에서 기존 순서를 유지하며 독립 효과마다 실패 기록·계속 처리. woken/providers 각각 한 대상 실패도 나머지 차단 안 함. 진단에 효과 종류·조직/run/provider 식별 정보를 쓰고 진단 실패도 전파 차단 | P02 | 현재 개별 구현 catch에만 의존하면 주입 예외가 공통 계약을 깨뜨림. 순서 보존 위해 전체 Promise.allSettled 일괄 병렬화는 피함 | Q2 |
| <a id="D04"></a>D04 | 변형 채택 | 복구는 저장 단계에서 결과/효과를 수집만 하고 전체 성공 뒤 적용. 그 뒤 pending/provider 촉진. 다른 시작 경로도 장벽 뒤 개방 | P03 | 거대 tx 불필요. 뒤쪽 저장 실패 때 앞 tx는 유지하되 효과·모델 호출0. 다음 시작은 남은 running만 복구하고 durable pending/Event 재조회로 맞춤 | Q3 |
| <a id="D05"></a>D05 | 채택 | kickProvider/kickOrganization은 첫 조회 완료까지만 기다리고 kick은 signal 전달 유지. 종료 효과에서 자기 pump·drain·새 실행 완료를 await하지 않음 | P04 | 현재 kickedAgain 방식 재사용. 긴 provider 실행을 gate로 붙잡은 상태에서 종료 적용기가 먼저 반환하는지 검증 | Q4 |
| <a id="D06"></a>D06 | 채택 | 취소 우선·세션 세대·원자 usage·wake 복원·조직 잠금/admission은 core/DB에 유지. 슬롯 촉진은 resume 효과를 만들지 않음 | P05/E04 | 초기 승인·최종 완료·조직 격리 및 pause를 전달 계층에서 다시 해석하지 않음 | Q1,Q5 |
| <a id="D07"></a>D07 | 배제 | outbox/exactly-once·자동 task 재실행·거대 복구 transaction·새 budget seam을 이번 통합에 도입하지 않음 | P01/P03/P05, #141 Out of Scope | 비용·정책·전달 보장 확대가 기존 결정과 불일치. 판4 회계/admission 직렬화는 영속 변경 경로의 후속 결정 | Q3,Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 중복 종료면 후속 처리 전부 생략 | BullMQ lock/active guard(E11) | Event 중복 방지와 촉진 재시도는 다른 요구 |
| after-commit이라는 이름만 믿고 예외 전파 허용 | Django nonrobust·현재 AfterCommit(E06/E09) | 이미 저장됐어도 외부 성공 반환을 막고 다른 효과도 중단 |
| 복구된 실행 시도마다 즉시 공통 적용 | per-item hook 일반화 | providersFreed/woken이 뒤쪽 미복구 상태에서 모델 실행을 시작할 수 있음 |
| 전달 실패를 실행 실패로 바꾸거나 프로바이더 재호출 | queue redelivery 일반화 | 원래 종료 결과 보존 계약과 불일치 |

## 구현 참고

권고 요약: 원자적 단일 종료 + 중복 시 재촉진 + 공통 효과 실패 격리 + 전체 복구 저장 장벽 + 첫 조회까지만 대기.

- `packages/core/src/run.ts`: 현재 종료·중단·세션 판단을 유지한다.
- `packages/db/src/runs.ts`, `stored.ts`: 종료 결과와 after 지시를 기존 형식에 맞추되 영속 판단은 transaction 안에 둔다. 저장 함수 내부에서 효과를 적용하지 않는다.
- `apps/server/src/after-commit.ts`: 효과 순서·개별 실패 격리·진단의 공통 책임.
- `apps/server/src/dispatcher.ts`: 동일 결과 저장 재시도와 저장 뒤 적용 경계, first-query 대기 유지.
- `apps/server/src/app.ts`: 공통 적용기 주입·시작 전체 복구 장벽의 조립 위치. 순환 runtime 의존성을 만들지 않게 기존 type import/조립 방식을 따른다. 새 외부 adapter는 만들지 않는다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 종료 중 각 DB 쓰기 실패 → rollback → 상태·usage·세션·Event 전부 이전 값. 같은 결과 재저장 → 한 번만 기록 | D01/D02 |
| V02 | commit 성공 뒤 응답만 유실 → finish 재시도 → Event/usage 추가0, provider 재실행0, 대기자 촉진 재시도 가능 | D01/D02 |
| V03 | publish/settings/cancel/resume/kick/provider 각 예외 + 여러 대상 → completeStored 결과 유지·진단·독립 나머지 호출. 진단 경로 예외도 같은 검사 | D03 |
| V04 | 여러 running 중 뒤쪽 복구 저장 gate/실패 → 앞 commit 확인해도 Event 적용·모델 호출0. 전체 성공 → 적용·pending 촉진 | D04 |
| V05 | 복구 중간 실패 뒤 재시작 → 앞 종료 재기록0·남은 running 복구·원래 입력/heartbeat 병합 유지. 누락된 휘발 Event 즉시 전달을 새로 요구하지 않음 | D04/D07 |
| V06 | 동일 agent pump 안 종료 → provider 첫 조회에서 자신/다른 agent 촉진 → 새 provider를 gate로 붙잡아도 종료 적용은 반환. pump 완료를 기다리는 음성 대조는 timeout | D05 |
| V07 | 취소 뒤 성공·provider 변경 뒤 옛 세션 → 저장 → cancelled 유지·세션 부활0·실제 옛 provider 촉진 | D01/D06 |
| V08 | A/B 조직·pause·초기 승인 전·최종 완료 상태 → 촉진 → 조직 간 기록 혼입0, 임의 resume0, 금지된 provider 호출0 | D06 |

기존 DB runs/sessions 검사, server runs/control/recovery 검사와 after-commit 순서/workspace 실패 검사를 확장할 경계다. 내부 helper 호출 순서 대신 영속 상태·Event·wake·provider 호출 여부/순서를 관찰한다. 이번 조사는 해당 제품 시나리오 전체를 실행하지 않았다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| Stored의 종료 value·없는 run 처리 형태 | #141 구현 | 기존 호출자가 필요로 하는 값 또는 명시적 결과. 필수 외부 동작은 D01이며 새 도메인 정책 아님 |
| 효과 실패 진단의 형식 | #141 구현 | 현재 console 진단 확장 또는 기존 로깅 통합. 영속 outbox 추가 없이 식별 가능한 실패 기록 필요(D03) |
| 더 강한 전달 보장·판4 예산 동시성 | 후속 판4 이슈/사용자 | 현재 재조회·시작 복구 유지 또는 별도 outbox 검토. 예산 회계·예약/admission 직렬화는 별도 명세. 이번 blocker 아님 |

## 한계와 미확인

- 실행 확인은 원본 AfterCommit+fake 의존성 9case, 원본 Django+메모리 SQLite 4case다. PostgreSQL 동시 종료·실제 commit 응답 유실·실제 dispatcher 자기 pump 교착·전체 시작 장벽은 이번 실행으로 검증하지 않았다.
- BullMQ/Redis, APScheduler/SQLAlchemy 전체 실행과 upstream 전체 테스트는 미실행이다. 읽은 테스트와 실행 결과를 구별한다. Django 5.2.8 진단 반례를 최신 모든 릴리스에 일반화하지 않는다.
- 접근 불가: GitHub parent 조회 404는 parent 없음 응답이다. 로그인 서비스·유료 API·실제 모델·실제 연구 데이터는 조사하지 않았다.
- commit 후 crash/복구 중간 실패 때 수집된 휘발 효과는 잃을 수 있다. durable Event·wake 재조회와 startup 복구 이상의 즉시/정확히 한 번 전달은 보장하지 않는다.
- upstream 변경 시 새 SHA로 다시 읽는다. 이번은 설계 참고로 코드 복사·NOTICE 변경 없음.

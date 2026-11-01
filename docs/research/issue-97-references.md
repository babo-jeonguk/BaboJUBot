# issue-97 레퍼런스 조사: 조직 도구 MCP·작업 폴더·파일 산출물

조사일: 2026-11-01. 대상: [#97](https://github.com/babo-jeonguk/BaboJUBot/issues/97), 부모 [#91](https://github.com/babo-jeonguk/BaboJUBot/issues/91). 구현 전 권고이며 확정 계약이나 구현 완료가 아니다. 상세 자료: `.reference-cache/issue-97/`(git 무시). 제품 코드·테스트·설정은 변경하지 않으며 이 문서는 구현 변경과 함께 커밋하도록 둔다.

## Brief

- 구현할 문제: 기존 조직 도구를 HTTP MCP로도 열고, 조직·개인 폴더를 실행 시도 작업 공간에 실으며, 조직 폴더 파일의 등록 시점 내용을 보존해 산출물 목록·단건과 결과 제출에서 참조한다.
- 동종 문제: **서로 다른 전송 경로를 같은 실행 신원·쓰기 판정에 연결하고, 변경 가능한 작업 파일을 출처가 있는 불변 기록으로 전환하는 경계**.
- 고정된 결정: 초기 연구 승인·최종 완료·조직 경계는 제품 코드가 강제한다. 도구 정의는 contracts 한 곳, 판정은 core·DB 저장 경계에 둔다. 실행 위치는 조직 폴더이며 개인 폴더는 중간 자료용이다. 같은 조직의 다른 개인 폴더는 읽기만 허용한다. 이 파일 접근 권한은 격리 켠 경우 컨테이너, 꺼진 경우 지침이 지킨다는 부모 #91의 결정을 따른다. Docker·전용 listener는 후속 #102다. 기존 본문 직접 등록·HTTP 경로·결과 제출을 유지한다. 파일 종류·이름·크기·시각과 본문/이름-값 표, 설명문 없는 화면은 #97의 계약이다.
- 부모 댓글까지 확인했다. #96은 PR #106의 merge `a22c769`으로 완료됐고 #97의 열린 blocker와 기존 댓글은 없다. 기준 자체 HEAD는 `a22c7691733d89e9cbf1669a53ed94045a1e769e`다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 단일 도구 목록을 MCP list/call로 옮기면서 run token·Role·단계·승인 정책·조직·같은 호출 키를 어떻게 같은 판정으로 유지하는가? | #97 AC1·6, #86, ADR-0001·0003·0005 | API·프로토콜 Source Recon + adversarial scenario + 무모델 probe |
| Q2 | 조직·개인 폴더 생성과 재시도·기존 조직 복구, cwd와 자기/동료 경로 전달 책임은 어디에 두는가? | #97 AC2–3, 부모 #91 작업 공간·격리, GLOSSARY | Source Recon + persistence/recovery, 격리 경계 대조 |
| Q3 | 조직 밖·없는 파일·symlink·경합을 거부하고, 등록 뒤 변경·삭제·재호출에도 내용과 결과 제출 근거를 보존하는가? | #97 AC4·6, GLOSSARY 산출물 | Source Recon + persistence/recovery + filesystem 음성 대조 |
| Q4 | 파일 목록과 단건을 좁은 폭·긴 이름·텍스트/바이너리에서 어떻게 표현하는가? | #97 AC5·7·화면 조건, 화면 지침 H | Surface Capture + Behavioral Recon + DS Source Recon |

| 재사용한 조사 | 쓰는 범위 | 재확인·판단 |
|---|---|---|
| [#86](issue-86-references.md#결정-권고) | 정의 단일 출처·노출과 허가 구분, 영어 도구 설명·한국어 결과 | 현행 contracts/tools.ts·server/tools.ts·db/tool-calls.ts를 직접 읽었다. 구 MCP 2025 자료를 최신 프로토콜 보장으로 재사용하지 않는다 |
| [연결 방식](provider-connection-references.md#d2-조직-도구-노출) | HTTP MCP·run bearer 및 provider별 주입 위치의 출발점 | 과거 provider 실행·argv 보안을 이번에 재검증한 것으로 세지 않는다. 실제 주입·로그인·모델은 후속 #98·#100·#101 |
| [프로바이더 선택](executor-selection-references.md#5-workspace와-격리) | provider 선택과 cwd/격리의 독립 | 부모의 조직 cwd가 우선. 작업별 worktree를 새로 도입하지 않는다. 기존 upstream 파일 근거는 재사용하지 않음 |
| [#55](issue-55-references.md#brief) | 본문 산출물·출처·자기 보고·조직 귀속·결과 근거 | 현행 contracts/task.ts·db/tasks.ts·db/results.ts·web/tasks.tsx로 현재 계약 재확인. 기존 캡처·실행 결과를 신규 근거에 합산하지 않음 |
| [화면 지침](design-guidelines-pan2.md#h-산출물-목록단건조직-폴더에서-등록한-파일) | 종류 아이콘·가운데 말줄임·크기/시각·본문/메타데이터 | 확정된 #97 요구로 재사용. 새로운 공개 실화면 관찰과 구분 |
| [격리 조사](executor-isolation-references.md)·[#96](issue-96-references.md#brief) | host 신뢰 한계와 작업별 세션·cwd 연속성 | 참고 연결만 재사용. 임의 셸의 파일 접근을 #97 경로 검사로 막았다고 주장하지 않음 |

## 레퍼런스

Discovery는 MCP(3라운드: 기존 표준→SDK/운영 OSS→인증·호환 실패 테스트), 파일(3라운드: 파일/산출물 OSS→저장·격리 부품→보안 권고·실패 테스트), 화면(기존 가이드→공개 DS·인접 말줄임→실제 예제)으로 나눴다. 마지막 탐색은 각각 요청 신원·receipt, 경로/사용 경합·부분 publish, 행 구성·끝부분 보존 패턴의 변형으로 수렴했다. 전수조사나 영구적 포화를 뜻하지 않는다. 후보별 실행 경로와 제외 이유는 `candidates.md`와 `notes/`에 둔다.

| 레퍼런스 | 분류 | 고정 SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|---|
| MCP 명세 | 표준 | `0aab7058fe6471f3d7b0301e13965f10ad9cb198` | MIT→Apache-2.0 전환, 비명세 문서 CC-BY-4.0 | 문서: 2026-07-28과 2025 호환 경계 |
| MCP TypeScript SDK | 서버 부품 | `1e608caeb5130b2ad0fa067c84b26a038c1c6e36` | 위와 같은 전환 | 소스·테스트 읽기: 요청별 factory·외부 인증. 실행 시도 실패 |
| MCP filesystem | 파일 경계 | `194cc86e3ae6400958555bd4116849d822d69263` | 위와 같은 전환 | 소스·helper 실행: symlink·parent 교체 반례 |
| MLflow | 산출물 저장 | `a1d0c1d6398c28c5b7cbbc0e4ba0e4b28d23eb29` | Apache-2.0 | 소스·테스트 읽기: staging·같은 이름 덮기 반례 |
| SEED | 디자인 시스템 | `99efaf5561de6e18557ffeb57fe95428ce066eb3` | Apache-2.0 | 소스·공개 예제: 행 구조·가운데 말줄임 |

외부 코드는 **설계 참고만** 한다. SDK는 최근 release v2.4.0이 있지만 읽은 HEAD와 해당 tarball의 일치·engines·의존성 호환은 검증하지 않았다. 도입 버전을 이 조사에서 확정하지 않는다. Paperclip public MCP는 보조 문서, Ant Design은 화면 대조이며 제품 의존성 권고가 아니다.

## 근거

아래 E는 이번 조사에서 확인한 사실이다. 테스트는 실행을 명시하지 않으면 읽기만 했다. 메인이 결정에 쓴 원문·캡처를 재열람한 기록은 `main-verification.md`다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 현행 tool 목록이 설명·입력·출력·Role·단계를 소유하며 HTTP path/body 분해도 제공한다. workspace는 cwd만 있는 nullable 계약이다 | [도구](https://github.com/babo-jeonguk/BaboJUBot/blob/a22c7691733d89e9cbf1669a53ed94045a1e769e/packages/contracts/src/tools.ts#L115-L152), [분해](https://github.com/babo-jeonguk/BaboJUBot/blob/a22c7691733d89e9cbf1669a53ed94045a1e769e/packages/contracts/src/tools.ts#L680-L692), [run](https://github.com/babo-jeonguk/BaboJUBot/blob/a22c7691733d89e9cbf1669a53ed94045a1e769e/packages/contracts/src/run.ts#L188-L201) | 소스 확인 |
| <a id="E02"></a>E02 | 현행 HTTP digest는 raw params/body JSON의 SHA256. DB는 최신 gate 뒤 agent+key receipt를 검사하고 도구/digest가 같으면 기존 결과를 반환한다 | [HTTP](https://github.com/babo-jeonguk/BaboJUBot/blob/a22c7691733d89e9cbf1669a53ed94045a1e769e/apps/server/src/tools.ts#L156-L173), [toolWrite](https://github.com/babo-jeonguk/BaboJUBot/blob/a22c7691733d89e9cbf1669a53ed94045a1e769e/packages/db/src/tool-calls.ts#L103-L183) | 소스 확인 |
| <a id="E03"></a>E03 | 본문 산출물은 markdown/text+content이며 결과 제출은 같은 조직 artifact ID를 참조한다 | [계약](https://github.com/babo-jeonguk/BaboJUBot/blob/a22c7691733d89e9cbf1669a53ed94045a1e769e/packages/contracts/src/task.ts#L50-L61), [제출](https://github.com/babo-jeonguk/BaboJUBot/blob/a22c7691733d89e9cbf1669a53ed94045a1e769e/packages/db/src/results.ts#L54-L90) | 소스 확인 |
| <a id="E04"></a>E04 | 기존 32개 tool input의 JSON Schema 변환과 필드 설명 보존, path/body 분해·organizationId 추가 거부 PASS | `probes/catalog.mjs`, `catalog-log.txt`; Node24.21.0·Zod4.6.7, 설치 없이 키 없는 셸 | 실행 확인 |
| <a id="E05"></a>E05 | 2026-07-28 HTTP는 GET stream·protocol session을 제거했다. 요청별 POST·Origin 검사·로컬 loopback을 규정한다 | [명세](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/0aab7058fe6471f3d7b0301e13965f10ad9cb198/docs/specification/2026-07-28/basic/transports/streamable-http.mdx#L14-L68) | 문서 주장 |
| <a id="E06"></a>E06 | SDK는 modern/legacy 모두 요청별 factory를 사용하며 authInfo는 caller 전달값이다. legacy는 sessionIdGenerator undefined다 | [modern](https://github.com/modelcontextprotocol/typescript-sdk/blob/1e608caeb5130b2ad0fa067c84b26a038c1c6e36/packages/server/src/server/createMcpHandler.ts#L791-L798), [legacy](https://github.com/modelcontextprotocol/typescript-sdk/blob/1e608caeb5130b2ad0fa067c84b26a038c1c6e36/packages/server/src/server/createMcpHandler.ts#L331-L375), [인증 전달](https://github.com/modelcontextprotocol/typescript-sdk/blob/1e608caeb5130b2ad0fa067c84b26a038c1c6e36/packages/server/src/server/createMcpHandler.ts#L946-L991) | 소스 확인 |
| <a id="E07"></a>E07 | SDK 테스트는 raw bearer만 넣으면 anonymous, 검증된 authInfo를 전달하면 client identity라고 assert한다. legacy initialize/call은 별개 인스턴스다 | [auth test](https://github.com/modelcontextprotocol/typescript-sdk/blob/1e608caeb5130b2ad0fa067c84b26a038c1c6e36/packages/server/test/server/createMcpHandler.test.ts#L175-L188), [legacy test](https://github.com/modelcontextprotocol/typescript-sdk/blob/1e608caeb5130b2ad0fa067c84b26a038c1c6e36/packages/server/test/server/createMcpHandler.test.ts#L496-L525) | 소스 확인 |
| <a id="E08"></a>E08 | MCP는 요청 authorization에 따른 목록과 일정 순서를 허용/권고하며 protocol error와 isError 도구 실행 오류를 구분한다 | [목록](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/0aab7058fe6471f3d7b0301e13965f10ad9cb198/docs/specification/2026-07-28/server/tools.mdx#L62-L75), [오류](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/0aab7058fe6471f3d7b0301e13965f10ad9cb198/docs/specification/2026-07-28/server/tools.mdx#L738-L794) | 문서 주장 |
| <a id="E09"></a>E09 | filesystem은 문자열 root와 realpath target을 각각 검사한다. 없는 경로에는 생성 fallback이 있다. 일반 readFileContent는 단순 fs.readFile이다 | [validatePath](https://github.com/modelcontextprotocol/servers/blob/194cc86e3ae6400958555bd4116849d822d69263/src/filesystem/lib.ts#L451-L525), [readFileContent](https://github.com/modelcontextprotocol/servers/blob/194cc86e3ae6400958555bd4116849d822d69263/src/filesystem/lib.ts#L556-L561) | 소스 확인 |
| <a id="E10"></a>E10 | 안전 쓰기 helper는 parent를 동기 chdir/getcwd로 pin하고 leaf descriptor의 lstat/fstat identity를 확인한다. 새 파일은 O_EXCL, overwrite는 확인 뒤 truncate다 | [parent/leaf](https://github.com/modelcontextprotocol/servers/blob/194cc86e3ae6400958555bd4116849d822d69263/src/filesystem/pinned-directory.ts#L156-L280) | 소스 확인 |
| <a id="E11"></a>E11 | 원본 helper 직접 import로 정상 생성·기존 파일 거부·leaf symlink 생성/덮기 거부·parent 교체 거부 5사례 PASS | `probes/files-pinned.mjs`, `files-run-log.txt`; Node24.21.0·Linux, 키 없는 셸. 파일 등록 API 실행은 아님 | 실행 확인 |
| <a id="E12"></a>E12 | MLflow는 같은 디렉터리 staging→copy→os.replace 후 실패 cleanup. 같은 이름 재등록도 replace한다. 실패 stream 테스트는 기존 내용 보존·temp 제거를 assert한다 | [저장](https://github.com/mlflow/mlflow/blob/a1d0c1d6398c28c5b7cbbc0e4ba0e4b28d23eb29/mlflow/store/artifact/local_artifact_repo.py#L94-L170), [실패 test](https://github.com/mlflow/mlflow/blob/a1d0c1d6398c28c5b7cbbc0e4ba0e4b28d23eb29/tests/store/artifact/test_local_artifact_repo.py#L333-L357) | 소스 확인 |
| <a id="E13"></a>E13 | SEED middle truncate는 폭 측정·끝부분 보존·이분 탐색을 하며, story는 CJK/Latin·100/200/300px·글자 크기를 대조한다 | [hook](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/packages/react-headless/middle-truncate/src/useMiddleTruncate.ts#L29-L140), [story](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/docs/stories/MiddleTruncate.stories.tsx#L23-L70) | 소스 확인 |
| <a id="E14"></a>E14 | 공개 SEED List의 토글을 눌러 선택됨 상태를 만들고 1280×900·390×844에서 앞 아이콘/중앙 텍스트/끝 요소를 관찰했다. 메인이 성공 캡처 두 개를 직접 다시 열었다 | [공개 List](https://seed-design.io/react/components/list), `captures/captures.md`·`seed-list-affix-{1280,390}.png` | 실행 확인 |

근거 14행: 소스 확인9·실행 확인3·문서 주장2. 공개 사이트 배포와 고정 SHA가 같다는 증명은 없으며, 실행 관찰은 완성된 파일 산출물 행·viewer 동작이 아니다.

## 패턴

아래 표와 결정은 근거·이슈 계약을 종합한 **추론**이다.

| ID | 패턴 | 사례 | 프로젝트별 차이·장점 | 비용·실패 모드 |
|---|---|---|---|---|
| P01 | 전송은 변환, 신원과 업무 판정은 공통 | E01–E08 | SDK factory는 전송 수명, 기존 toolWrite는 조직·쓰기 수명 담당 | singleton 신원 누수, 목록만 필터링, 인증 middleware 누락 |
| P02 | 호출 신원과 같은 효과의 키를 구분 | E02·E06–E08 | run token은 실행 권한, agent+key는 재호출 결과 | JSON-RPC id를 키로 쓰거나 flat/wire digest 차이로 중복·conflict |
| P03 | 논리 작업 공간과 실제 파일 권한 분리 | 부모 #91·#102, E01·E09 | 고정 조직 cwd+자기/동료 경로; mount는 후속 | 경로 전달을 OS 격리로 오인, DB commit만 되고 폴더 생성 실패 |
| P04 | 경로 검사와 실제 descriptor 사용을 함께 검증 | E09–E11 | filesystem의 안전 쓰기는 parent/leaf를 각각 확인 | realpath 후 재open 경쟁·FIFO·hardlink, 안전 쓰기를 읽기 보장으로 일반화 |
| P05 | 완전한 bytes 보존과 record publish | E03·E12 | MLflow staging은 부분 노출 방지, 본 프로젝트는 ID별 불변성 추가 | 같은 이름 replace, DB/file 이중 쓰기·orphan, 복사 중 변경 |
| P06 | 데이터 형식별 본문과 파일 메타·끝부분 보존 | E13–E14, #97 화면 계약 | DS는 측정·행 구성 제공, 제품은 원래 이름·출처 유지 | suffix 소실·UTF-16 분할, 좁은 폭 overflow·tooltip 접근성 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | `orgTools`에서 MCP 이름·설명·JSON Schema를 생성하고 HTTP/MCP가 공통 dispatch를 호출. run 인증·Role/단계 gate·입력 검사·DB 최신 정책/조직 guard·activity·afterCommit까지 재사용 | P01, AC1 | 경로별 판정 복제를 막는다. 목록 필터와 call 검사는 별개이며 최종 완료·승인 결정 도구는 추가하지 않음 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | 요청마다 bearer 재검증, 신원은 토큰에서만. factory/요청 맥락을 분리하고 Origin/Host 검사·안전한 오류 code를 전송 앞단에 둔다 | P01·E05–E08 | SDK가 bearer를 검증해 준다고 가정하면 anonymous로 열린다. MCP 업무 거부와 HTTP 응답은 같은 판정·효과를 보존하되 wire 오류 모양은 구분 | Q1 |
| <a id="D03"></a>D03 | 변형 채택 | agent+key receipt를 공통 사용하고 digest 변환을 명시한다. 기존 raw HTTP 분해 재현 또는 버전 있는 canonical digest 이행 중 선택. replay는 기존 guard 통과 뒤 원본 파일을 읽기 전에 해소 | P02·E02 | MCP→HTTP·HTTP→MCP 재시도, 다른 입력 conflict가 동일해야 한다. 기존 receipt와 optional/default·키 순서도 검증. RPC id는 같은 호출 키가 아님 | Q1·Q3 |
| <a id="D04"></a>D04 | 채택 | 서버 데이터 루트 아래 org/agent ID로 폴더를 만들고 cwd=조직 폴더, 자기/같은 조직 동료 개인 폴더를 요청에 구조적으로 전달. fs는 서버 소유 경계에 둔다 | P03, AC2–3 | DB 트랜잭션과 mkdir는 하나의 원자 작업이 아니므로 생성 응답/dispatch 전 ensure, 실패 재시도·재시작/기존 조직 보정 필요. 명칭·표시 이름을 경로 키로 쓰지 않음 | Q2 |
| <a id="D05"></a>D05 | 변형 채택 | 등록 입력은 조직 폴더 기준 상대경로를 우선 권고. 절대경로를 받는다면 같은 root 검사 필수. 구분자 containment·real target·regular file·안전 open/descriptor를 검사하고 없는 파일·디렉터리·경계 밖은 거부 | P04·AC4 | 새로운 파일 생성 fallback은 불필요. symlink/parent 교체를 대조한다. 경로 검사는 임의 셸의 OS 권한 강제 수단이 아니며 안전 읽기 구현을 별도 검증해야 함 | Q3 |
| <a id="D06"></a>D06 | 변형 채택 | 원본을 bytes로 복사해 ID별 불변 저장하고 원래 상대경로·파일명·종류·byte 크기·등록시각·작성 agent/run/task를 record에 남김. 기존 본문형을 별도 유지 | P05·E03·E12 | workspace 링크나 hardlink를 보존본으로 쓰지 않음. 결과 제출은 record ID와 그 보존본만 참조. hash는 무결성 보조이며 조직 경계를 대신하지 않음 | Q3 |
| <a id="D07"></a>D07 | 보류 | 저장 매체/상한은 #97에서 결정. 작은 제한 파일의 DB bytes 동시 transaction 또는 서버 전용 object 파일+DB 참조 중 선택 | P05 | 전자는 원자성·운영 단순, 큰 파일/메모리 비용. 후자는 크기 대응 유리하나 staging→publish→DB commit·orphan 정리·재시작 복구·디스크 실패 검사 필요 | Q3 |
| <a id="D08"></a>D08 | 채택 | 파일 종류 아이콘·원래 이름의 가운데 말줄임+전체 이름 tooltip·크기·등록시각. 단건 Markdown/text는 보존 본문, 바이너리는 이름/종류/크기/시각/원래 경로 표. 기존 출처 링크 유지 | P06, AC5·7 | 파일명과 제목을 구분한다. 설명문·미리보기 불가 배너를 추가하지 않으며, HTML/SVG 등 임의 활성 내용을 본문으로 실행하지 않음 | Q4 |
| <a id="D09"></a>D09 | 보류 | MCP 지원 revision·SDK pin·호출별 key 전달 위치는 #97과 후속 adapter wire 검증으로 고정. 2026/2025 규약을 구분 | E05–E08·P02 | 최신은 protocol session이 없지만 실제 provider가 2025를 사용할 수 있음. legacy stateless 지원 SDK를 후보로 두되 설치/호환 전 채택 확정하지 않음 | Q1 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 목록 노출·annotations·MCP session만으로 권한 판정 | 기존 #86, E05–E08 | 토큰 종료·우회 call·조직 경계 재검사가 빠짐 |
| 평탄 MCP 입력을 별도 hash하고 RPC id로 dedup | E02 | 기존 같은 호출 키 의미·다음 run 재시도와 불일치 |
| 같은 basename에 replace 또는 원본 경로를 매번 읽기 | MLflow E12 | 원본 수정·동명 재등록 뒤 과거 산출물/결과 근거가 달라짐 |
| 문자열 startsWith·마지막 O_NOFOLLOW만으로 완전한 경계 주장 | E09–E11 | 인접 prefix·parent 교체·hardlink가 별도 문제 |
| 작업마다 worktree, generic filesystem MCP 전체 도입 | 기존 선택 조사·filesystem | 고정 조직 cwd·등록 범위를 넘고 별도 쓰기 도구는 불필요 |
| peer RO를 경로 목록/지침만으로 강제했다고 보고 | 부모 #91·#102 | host 실행 신뢰 한계와 충돌. 실제 mount/네트워크 검사는 후속 #102 |

## 구현 참고

구현은 도구 dispatch 공유→workspace 경로/생성→본문형과 호환되는 파일 snapshot→목록/단건 순서로 연결하는 편이 검증하기 쉽다. 위치는 현재 [코드 지도](../agents/code-map/tasks.md)와 [전체 구조](../architecture.md)를 따른다.

- `packages/contracts/src/{tools,task,run}.ts`: 단일 도구 정의·파일/본문 계약·workspace 경로 데이터. 입력과 출력 schema를 혼용해 기본값/optional 뜻을 바꾸지 않는다.
- `packages/core/src/task.ts`: 순수 연구 기록 규칙, fs·SDK import 없음.
- `packages/db/src/{tasks,tool-calls,results}.ts`·schema/migration: 조직·run 출처·receipt·불변 record·결과 참조. 기존 본문 행을 새 file 값으로 임의 변환하지 않는다.
- `apps/server/src/{tools,run-request,app,main}.ts` 인접 module: 공통 dispatch·MCP transport·서버 데이터 루트·파일 IO. PG의 `dataDir`과 일반 파일 루트를 암묵 혼용하지 않고 서버 시작 계약으로 주입한다. 조직/agent 생성·초기 승인·추가 작업자 경로 모두 ensure 대상이다.
- `apps/web/src/tasks.tsx`·API summary/detail: 제목/파일 이름, byte 크기·MIME·원래 경로를 보존본 metadata에서 읽는다. 후속 adapter는 토큰을 argv/공개 활동에 노출하지 않는 주입을 #98·#100·#101에서 검증한다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 같은 run·도구·입력 → HTTP/MCP call → 성공·거부 code·저장 효과·Event·깨우기 동일 | D01–D02 |
| V02 | 종료/취소 token·목록 밖 직접 call·worker가 Lead 도구·승인 전 작업·타 조직 ID → 양쪽 경로 → 기존 거부, 기록 누출/쓰기 없음 | D01–D02 |
| V03 | 승인 정책 on/off·일시정지/최종 완료가 call 중 변경 → 저장 경계 → 최신 잠금 판정 동일; user-only 제어 도구 없음 | D01 |
| V04 | 같은 agent/key/input HTTP↔MCP·다음 run 재호출 → receipt → 최초 결과 하나, 다른 입력/도구 conflict, 다른 agent 키 분리 | D03 |
| V05 | 조직·Lead·초기 팀·추가 작업자 생성/실패 재시도/재시작·기존 조직 → ensure와 dispatch → 조직 cwd·자기/동료 경로 존재, 다른 조직 경로 없음 | D04 |
| V06 | `../`·인접 prefix·절대 타 조직·없는 파일·디렉터리·symlink 밖·parent swap·FIFO → 등록 → 안전하게 거부, 비밀 bytes 미보존 | D05 |
| V07 | 정상 Markdown/text/binary/빈 파일 → 등록 후 수정·삭제·동명 재등록 → 기존 산출물·결과 제출 내용/metadata 그대로, 별도 등록은 별도 ID | D06 |
| V08 | 최초 등록 뒤 원본 삭제/변경·같은 key replay → 원본 IO 이전 receipt → 기존 snapshot 반환; 다른 경로 입력은 conflict | D03·D06 |
| V09 | 읽기 중 변경·크기 초과·디스크 실패·publish 뒤 DB 실패·서버 crash → 선택 저장 정책 → 부분 artifact/중복 Event 없음, 재시도·orphan 복구 검증 | D05–D07 |
| V10 | 파일 목록/단건·390px·긴 한글/emoji/확장자·0byte → E2E → 이름·단위·전체 이름 접근·등록시각·본문/표 분기, 설명문 없음 | D08 |
| V11 | 기존 판1 본문 산출물·결과 제출 → 회귀 suite → 이전 데이터·출처·최종 완료 흐름 그대로 | D06·D08 |
| V12 | 선택 SDK/revision별 initialize/discover/list/call·unsupported version·Origin·호출별 key → wire 검사 → 명시 지원과 안전한 거부 | D02·D09 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| R1 MCP revision·key 위치 | #97 (adapter 지원은 #98·#100·#101) | 2025 우선 고정 / 2026+legacy 호환. 후자를 후보 권고하나 실제 provider와 pin 검사 필요. key는 호출별 header 또는 namespaced `_meta`; 고정 설정 header만 가능한 client의 입력별 key 전달은 추가 계약 검토. schema 밖 metadata면 기존 도구 입력 유지 가능 |
| R2 저장 매체·크기/본문 판정 | #97, 사용자 정책 영향 시 사용자 | 제한 DB bytes / 파일 store+DB 참조. 최대 bytes·허용 UTF-8 text 판정·MIME/확장자 처리·preview 한도를 명시하고 0byte와 미리보기 생략 의미를 보존 |
| R3 symlink·복사 중 변경 | #97 | component symlink 전부 거부 / 조직 안 target만 허용. 전자가 단순하나 연구 repo 링크 제약. descriptor 전후 stat로 변경 감지·거부하거나 write-then-rename 협력 규칙. 전후 stat만으로 동시 writer에 대한 단일 시점 snapshot이 보장되지는 않음 |
| R4 기존 receipt 이행·폴더 복구 | #97 | 기존 HTTP digest 재구성 / versioned canonical 이행; 기존 조직 시작 시 보정 / 명시 이행+dispatch ensure. 데이터 원본을 잃지 않는 방식으로 현재 행·재시도 검증 |

## 한계와 미확인

- 실제 모델·로그인·유료 API·자격 증명 사용 없음. 제품 구현·제품 검사·전체 upstream suite는 실행하지 않았다. 실제 provider MCP 호환·call별 key 주입·토큰 redaction은 후속 adapter에서 확인한다.
- SDK self-host는 `systemd-run --user` 메모리 제한의 user bus 부재로 npm 시작 전에 실패했다. SDK runtime·설치 호환은 미확인이며 실패를 SDK 동작 부재로 해석하지 않는다.
- 파일 helper 5사례는 안전 **쓰기** 동작만 확인했다. 등록의 안전 읽기·hardlink·동시 writer·DB/file crash 내구성·fsync·Windows/macOS 대소문자 규칙은 미확인이다. 경로 검사로 동일 OS 사용자 임의 셸을 격리했다고 주장하지 않는다.
- 전체 history/blame·연결 PR의 변경 이유는 충분히 추적하지 않았다. 공식 filesystem advisory의 parent swap·case variant는 탐색에 반영했지만 공격 PoC 전체 재현은 하지 않았다. 최신 SHA에서도 일반 read helper는 단순 read다(E09).
- upstream 기존 SHA의 소스 근거를 동일하다고 재사용한 것은 없다. 새 SHA를 독립 열람했고 SEED만 기존과 같은 SHA다. 복사 시 LICENSE/header/NOTICE·전이 의존성을 다시 확인하고 AGENTS 출처·THIRD_PARTY_NOTICES 규칙을 적용해야 한다.

- 공개 UI 확인은 SEED 목록 예제 두 폭의 성공 관찰까지다. 파일 viewer·로딩/빈/실패 상태·전체 이름 tooltip·스크린리더·터치·font scaling 실동작은 미확인이다. Ant 공개 예제는 좁은 폭의 가로 넘침이 있어 성공 배치 근거에서 제외했다. 외부 캡처는 캐시에만 두며 저장소·이슈에 올리지 않는다.

## 구현 기록 — #97

기준 `a22c7691733d89e9cbf1669a53ed94045a1e769e`, 브랜치 `feat/97-mcp-file-artifacts`. 위 조사 권고와 달리 아래는 이번 구현에서 선택한 범위다.

- MCP: [고정 SHA의 2025 HTTP 원문](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/0aab7058fe6471f3d7b0301e13965f10ad9cb198/docs/specification/2025-11-25/basic/transports.mdx)과 [2026 변경 원문](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/0aab7058fe6471f3d7b0301e13965f10ad9cb198/docs/specification/2026-07-28/basic/transports/streamable-http.mdx)을 GitHub API로 직접 열었다. 2025 세션 없는 JSON 응답을 채택하고 initialize/ping/tools만 구현했다. SDK·2026 규약 지원은 채택하지 않았다. SDK 링크는 웹 도구에서 열리지 않았으며 이번 구현 근거로 쓰지 않았다. HTTP/MCP는 명시적 입력·상태/값 공통 dispatch, 현재 Role·단계 목록, 요청별 bearer, loopback Host/Origin 검사를 사용한다.
- 재호출: 기존 HTTP raw params/body digest를 유지한다. MCP는 원래 필드 순서를 보존해 같은 모양으로 옮기며 `_meta["idempotency-key"]` 또는 header를 쓴다. DB guard·receipt 확인 뒤 파일을 읽으므로 원본 삭제 후에도 같은 결과다. 필드 순서 canonicalization은 기존 receipt 이행이 필요해 이번에 하지 않았다.
- 파일: [filesystem validatePath 원문](https://github.com/modelcontextprotocol/servers/blob/194cc86e3ae6400958555bd4116849d822d69263/src/filesystem/lib.ts#L451-L525)과 [MLflow staging/publish 원문](https://github.com/mlflow/mlflow/blob/a1d0c1d6398c28c5b7cbbc0e4ba0e4b28d23eb29/mlflow/store/artifact/local_artifact_repo.py#L94-L170)을 직접 열었다. 경로와 실제 대상 재검사를 채택하되, 10 MiB 상한·DB base64 bytes 동시 transaction을 선택해 외부 파일 store publish/orphan 문제를 피했다. 기존 이름 overwrite·생성 fallback·symlink/hardlink는 배제했다. Linux descriptor 경로와 전후 stat를 확인한다. 임의 동시 writer의 단일 시점 snapshot이나 다른 OS 지원은 주장하지 않는다.
- 화면: [SEED 공개 List](https://seed-design.io/react/components/list)를 직접 열고 390px Chromium에서 토글 행 클릭 후 checked=true를 확인했다. 성공 캡처를 직접 열어 앞 아이콘·중앙 내용·끝 컨트롤 구조를 확인했다. 제품은 같은 행 구조와 CSS 가운데 말줄임을 사용하고 키보드/hover tooltip을 링크에 붙인다. upstream 코드를 복사하거나 의존성을 추가하지 않았다.
- 작업 폴더: 생성 후·실행 요청·서버 시작에 누락 폴더를 준비한다. 파일 시스템 실패는 이미 commit된 조직·승인 효과를 막지 않고 로그와 실행 시도 실패로 남으며 다음 요청/시작 때 복구한다. 동료 read-only는 workspace 계약이며 컨테이너 강제는 #102에 남는다.

검증 경계는 #97에 명시된 서버 HTTP/MCP·실행 요청·브라우저다. 실제 모델·로그인·유료 API 호출은 하지 않았다. 화면 E2E의 파일 응답은 fixture이며 실제 파일 등록·DB 보존·결과 제출·재시작은 별도 서버 통합 검사다. 최초 MCP red 실행은 sandbox listen 제한으로 시작하지 못해 red 증거로 세지 않는다. 브라우저 검사에서 발견한 단건 조회 인자 오류는 수정 전 실패·수정 후 기존/신규 3개 통과로 확인했다. 최종 검사와 리뷰 처리 기록은 PR에 둔다.

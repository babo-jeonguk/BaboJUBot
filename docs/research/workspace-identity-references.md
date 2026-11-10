# workspace-identity 레퍼런스 조사: 조직 ID와 작업 폴더의 결합

조사일: 2026-11-04. 대상: 사용자 조사 위임 「제품의 조직 폴더와 조직 ID를 어떻게 묶을 것인가」. 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/workspace-identity/`(git 무시). 제품 기준 소스는 `9efe7f376badb9739b3d70443197c838abff3a6e`이며, 조사 중 생긴 별도 작업 트리 변경은 아래 한계에 구분했다.

## Brief

- 구현할 문제: DB에서 인증한 조직 A의 산출물을 읽을 때, A 경로에 놓인 B 폴더를 A로 오인하는 문제를 막는다.
- 동종 문제: 논리 ID와 교체·복원 가능한 저장소 루트의 정체성을 결합하고, 그 루트 아래 비신뢰 파일을 서버가 대신 읽는다. **정체 확인·경로 고정·쓰기 권한 격리는 서로 다른 계약**이다.
- 고정된 결정: 조직 UUID와 사용자 지정 공유만 허용하는 조직 경계를 유지한다. Node.js 서버, Linux·macOS·Windows, 일반 경로와 데이터 폴더 이동·백업 복원을 전제한다. 특정 inode·절대경로·Linux 전용 기능을 필수 영속 계약으로 삼지 않는다.
- 작업 경계: 지정 결과 문서와 `.reference-cache/`만 쓴다. 제품·테스트·설정 변경, commit/push, 이슈·댓글 게시, 자격 증명·로그인·유료/모델 API 사용은 하지 않는다. `BABOJUBOT_HOME` 아래 데이터와 `.env*`는 읽지 않는다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | DB ID와 폴더 식별 파일, 누락·불일치·이동·복원·inode 처리 | 사용자 위임 Q1·B/C/E·내부 ID 직관 | Source Recon + persistence/recovery |
| Q2 | 대리 파일 읽기·root 교체·경로 탈출·Node/OS별 기능 | 사용자 위임 Q2·외부 리뷰 재현 장면 | Source Recon + adversarial scenario |
| Q3 | 에이전트 제품의 테넌트/서버 소유 영역·공개 위협 모델 | 사용자 위임 Q3·A | Source Recon + adversarial scenario |
| Q4 | 내용 업로드 실제 사례·크기·재시도·권한 | 사용자 위임 Q4·D | API 계약 + Source Recon + failure |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [실행 격리 조사](executor-isolation-references.md) | OpenHands·Paperclip 후보 발굴, 기존 격리 문제와 연결 | 과거 소스 근거를 그대로 재사용하지 않았다. 이번 SHA의 원문을 새로 읽었다. OpenHands registry와 Paperclip SPEC에는 변경이 있어 과거 줄 번호를 옮기지 않았다 |
| [#98–101 조사](issue-98-101-references.md#구현-참고) | 동일 UID·workspace 설정 경합의 배경만 | 결론의 근거는 현재 제품 소스 E02–E05·E33으로 확인. 과거 실행 결과나 외부 소스의 동일성을 가정하지 않았다 |
| 기존 `.reference-cache/workspace-identity/brief.md` | 사용자 원문·쓰기 경계 | 요청과 대조. 기존 결론/실행 근거는 없었음 |

## 레퍼런스

선정 원칙은 패턴의 다양성과 공개 소스의 거부 분기다. 역사적 안정판의 구현을 현재 모든 버전의 보장으로 확대하지 않는다. 공개 원문은 **40자 SHA의 선택 파일 snapshot**으로 `.reference-cache/src/<owner>-<repo>@<sha7>/`에 받았으며 전체 checkout은 아니다. 모두 설계 참고이고 코드 복사 권고가 아니다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Kafka | 저장소 정체 | 3.9.0 · `84caaa6e9da06435411510a81fa321d4f99c351f` | Apache-2.0 | 소스 | 기대 node/cluster ID·directory ID 중복 검사, 미포맷 거부 |
| MinIO | 계층별 저장소 정체 | 2025-04-22 · `0d7408fc9969caf07de6a8c3a84f9fbb10a6739e` | AGPL-3.0 | 소스 | deployment/drive/set 식별과 누락 처리 |
| PostgreSQL | 데이터 계보 | 17.6 · `7885b94dd81b98bbab9ed878680d156df7bf857f` | PostgreSQL | 소스·문서 | pg_control–WAL–복제 상대 시스템 ID 결합 |
| Borg | 이동·복원 반례 | 1.4.1 · `ecf2dfa1701eb3522e86a03a33bb9988eb7f959c` | BSD-3-Clause | 소스·문서 | 논리 repo ID와 위치/과거 상태·inode cache 구별 |
| restic | 저장소 정체 보조 | 0.18.1 · `7d0aa7f2e30546fba7c8f1c0bae4d6704e3d8423` | BSD-2-Clause | 소스 | config ID만으로 외부 기대 ID 검사가 생기지 않음 |
| Syncthing | 존재 마커 반례 | 1.29.2 · `516f3e29e8cc7091ea6271715308caea0fcc0778` | MPL-2.0 | 소스·문서 | marker 안에 ID가 있어도 실제 검사는 존재만 확인 |
| GNU tar | 폴더 번호 영속 저장 | `d479b2cc9160d9c2fb61afbc9ee70c2faadf80db` | GPL-3.0-or-later | 소스·문서 | snapshot에 dev/ino 저장, NFS·LVM 예외 |
| Go os.Root | OS별 root-relative API | 1.24.0 · `3901409b5d0fb7c85a3e6730a59943cc93b2835c` | BSD-3-Clause | 소스 | Unix openat와 Windows handle/reparse 처리 비교 |
| filepath-securejoin | 문자열/handle API 비교 | `9e667cafd6b022fac5ae8711ace2204eeec95207` | BSD-3-Clause / MPL-2.0 | 소스·문서 | 구 문자열 API 실패와 Linux fd API |
| libpathrs / runc | root handle의 실제 소비자 | `05a4b54f9843ea1fb0ae86dc2f40550bde244589` / `642809e5e24b8ddad48ed64085cf33b226befd8f` | MPL-2.0 OR LGPL-3.0-or-later(조사 파일) / Apache-2.0 | 소스 | root 취득 전제·이동 정책과 mountpoint 처리 |
| Node.js | 서버 언어 제약 | `c085224f33efd7938fb267efff52ddf41cad7a9a` | MIT·의존성 고지 | 문서 | fs API·permission 한계·공개 제안 |
| Paseo | 로컬 신뢰 모델 | `66676d49e6336a75837abec247871553a7658c35` | Apache-2.0·별도 고지 | 문서 | 동일 OS 사용자 신뢰를 명시 |
| OpenHands SDK | 실행 경계 | `2f2cd2bf7f19ca3bbf9f0c4a95c60f48094302a1` | MIT | 소스·문서 | 대화별 container·부분 bind·보존/재개 |
| Paperclip | 앱 인가·업로드 | `630ed6624c71c26617a1e0f3c5e97384ece2caae` | MIT | 소스·문서 | 파일 격리 책임 구분·agent bytes 제출·재시도 실패 |
| E2B | VM 경계·전송 보조 | `9301cd84757b0e3f3fccbd349e85ff2bd403a1f4` | Apache-2.0 | SDK 소스·공식 문서 | VM 격리 주장과 buffered/stream 전송 차이 |
| Daytona | control/compute 분리 | 문서 v0.227 / 공개 README `ec4c21b2d597091ac09ecc278f3bcc172575a987` | 현 core 미확인 | 문서 | 조직 인가와 sandbox 내부 파일 서비스 구별 |
| Docker/Kubernetes CVE, openat2, Windows File ID, MLflow | 실패 보고·명세·인접 산출물 서비스 | 아래 원문 URL·2026-11-04 확인 | 구현 코드 미채택 | 문서·제한 실행 | 대리인 실패와 번호/업로드의 비용 |

관점별 saturation은 다음과 같다. 후보별 공식 URL·운영 상태·실행 경로·선정/제외 이유는 `.reference-cache/workspace-identity/candidates.md`에 모았다.

- 저장소: 3라운드에서 Kafka/MinIO/PG → backup·clone·marker 반례 → Ceph/Cockroach/Elasticsearch/Gitaly로 확장했다. 마지막 라운드는 논리 ID·존재 마커·별도 과거 상태로 수렴했다. 미열람 후보를 소스 근거로 올리지 않았다.
- 경로: CVE → openat2/라이브러리/소비자 → Node 제안·safeopen으로 확장했다. 마지막 라운드는 fd 기반 경계와 언어별 비용을 반복했다.
- 실행 제품·업로드: 4라운드에서 로컬 조직 제품 → 관리형 sandbox → 연구 산출물 proxy/direct upload → host 위협 모델을 대조했다. 마지막 라운드는 OS/VM 경계·동일 계정 신뢰·업로드 인가/재시도 변형에 수렴했다.
- 파일 번호: Borg cache만으로 부족해 GNU tar 폴더 snapshot·Windows file ID까지 확장했다. dev/ino의 지역성·변화 문제로 수렴했다. 이는 조사 범위의 포화이며 다른 해법이 없다는 증명이 아니다.

## 근거

수준은 **소스 확인 / 문서 주장 / 실행 확인 / 추론 / 미확인**으로 구분한다. 소스 확인은 해당 고정판 코드가 그렇게 작성되어 있다는 뜻이며 실행 보장이 아니다. 공식 README·명세·보안 정책은 저장소 안에 있어도 문서 주장이다. worker 보고를 근거 원문 대신 쓰지 않았으며 메인의 재열람 기록은 `.reference-cache/workspace-identity/main-verification.md`에 있다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 조직·agent·대화는 UUID PK와 이름/제목을 분리한다. 메시지·산출물·session은 조직+대상 ID 복합 FK를 둔다 | 제품 [schema organizations/agents](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/db/src/schema.ts#L63-L112), [대화/메시지](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/db/src/schema.ts#L290-L388), [산출물](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/db/src/schema.ts#L792-L829), [session](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/db/src/schema.ts#L1264-L1298) | 소스 확인 |
| <a id="E02"></a>E02 | 조직·개인 폴더는 UUID 경로를 조합한다. ensure는 DB 조직 존재 확인 뒤 mkdir recursive만 수행하며 폴더 신원 메타데이터를 읽지 않는다 | 제품 [Workspaces.organization/personal/ensure/forRun](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/apps/server/src/workspace.ts#L82-L120) | 소스 확인 |
| <a id="E03"></a>E03 | realpath 경계 확인 뒤 자식 cwd에서 각 단계의 현재 lstat과 진입 후 stat dev/ino를 비교한다. 파일도 open/fstat·link 수·크기를 검사한다. 비교 대상은 이번 호출의 관찰값이고 DB에 저장된 조직–폴더 결합값이 아니다 | 제품 [pinnedReader/readPinned](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/apps/server/src/workspace.ts#L18-L79), [readArtifact](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/apps/server/src/workspace.ts#L122-L147) | 소스 확인 |
| <a id="E04"></a>E04 | run token에서 주체를 얻고, 조직/실행 잠금·task 조직 확인 후 locked.organizationId로 파일을 읽는다. 읽은 bytes는 DB 산출물과 함께 저장된다 | [인증](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/apps/server/src/tools.ts#L162-L168), [recordArtifact](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/db/src/tasks.ts#L196-L237), [toolWrite](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/db/src/tool-calls.ts#L117-L157) | 소스 확인 |
| <a id="E05"></a>E05 | DB 대화 조회는 organizationId+conversationId로 한다. Workspaces에는 조직/agent 폴더만 있으며 DB 대화의 폴더는 읽은 경로에서 확인하지 못했다. native session은 DB JSONB이고 provider home은 연결별 경로다 | [findConversation](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/db/src/conversations.ts#L82-L98), E01/E02, [Claude home](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/runtime/src/providers/claude.ts#L60-L69), [OpenCode home](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/runtime/src/providers/opencode.ts#L43-L60) | 소스 확인; 부재는 읽은 범위 한정 |
| <a id="E06"></a>E06 | 제품 reader 문자열을 그대로 실행한 fixture에서 정상 A는 A, 외부 B symlink는 거부. B→A rename 및 organizations 전체 교체 뒤 B bytes 반환. cp 복원은 marker 내용 유지·inode 변경. 같은 writer는 marker도 A로 위조 가능 | `probes/identity.mjs`, `probes/run-log.txt` — Node v24.21.0/Linux x64, 명령은 아래 실행 범위 | 실행 확인(파일 경계만; DB/API 미실행) |
| <a id="E07"></a>E07 | Kafka verify는 기대 cluster/node ID와 저장값 불일치·directory UUID 중복을 거부한다. KRaft caller는 nodeId를 설정에서 주지만 cluster 기대값은 비워 디렉터리 간 일치를 검사한다. 비실패 디렉터리의 meta.properties 누락은 시작 거부이며 기존 메타데이터의 directory.id만 누락하면 생성한다 | [MetaPropertiesEnsemble.verify](https://github.com/apache/kafka/blob/84caaa6e9da06435411510a81fa321d4f99c351f/metadata/src/main/java/org/apache/kafka/metadata/properties/MetaPropertiesEnsemble.java#L472-L528), [initializeLogDirs](https://github.com/apache/kafka/blob/84caaa6e9da06435411510a81fa321d4f99c351f/core/src/main/scala/kafka/server/KafkaRaftServer.scala#L138-L176) | 소스 확인 |
| <a id="E08"></a>E08 | MinIO format.json에는 deployment ID와 drive This/set UUID가 있다. 누락은 unformatted 오류, JSON 오류는 반환. 참조 set의 UUID 배치 불일치와 This 미포함을 거부한다. 이 비교 함수가 deployment ID 자체도 검증한다고 일반화하지 않는다 | [formatMetaV1](https://github.com/minio/minio/blob/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e/cmd/format-meta.go#L20-L52), [loadFormatErasure](https://github.com/minio/minio/blob/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e/cmd/format-erasure.go#L388-L415), [formatErasureV3Check](https://github.com/minio/minio/blob/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e/cmd/format-erasure.go#L494-L524) | 소스 확인 |
| <a id="E09"></a>E09 | PostgreSQL pg_control에 system_identifier가 있고 WAL header·복제 상대와 대조한다. UUID/inode가 아니라 데이터 계보의 ID다. pg_control 누락·읽기 실패·CRC 오류도 거부한다 | [ControlFileData](https://github.com/postgres/postgres/blob/7885b94dd81b98bbab9ed878680d156df7bf857f/src/include/catalog/pg_control.h#L104-L110), [WAL ID 거부](https://github.com/postgres/postgres/blob/7885b94dd81b98bbab9ed878680d156df7bf857f/src/backend/access/transam/xlogreader.c#L1276-L1287), [복제 ID 거부](https://github.com/postgres/postgres/blob/7885b94dd81b98bbab9ed878680d156df7bf857f/src/backend/replication/walreceiver.c#L342-L356), [ReadControlFile](https://github.com/postgres/postgres/blob/7885b94dd81b98bbab9ed878680d156df7bf857f/src/backend/access/transam/xlog.c#L4308-L4371) | 소스 확인 |
| <a id="E10"></a>E10 | PostgreSQL 파일 백업 문서는 정지한 전체 cluster 또는 일관 snapshot을 요구한다. ID 파일만 맞아도 부분/비일관 복원이 안전해지는 것은 아니다 | [backup.sgml filesystem backup](https://github.com/postgres/postgres/blob/7885b94dd81b98bbab9ed878680d156df7bf857f/doc/src/sgml/backup.sgml#L359-L425) | 문서 주장; 마지막 해석은 E09와의 추론 |
| <a id="E11"></a>E11 | Syncthing marker 내용에는 folderID가 있지만 CheckPath는 root와 MarkerName의 존재만 검사한다. 누락은 ErrMarkerMissing이다. 따라서 다른 ID의 폴더를 거부하는 사례로 쓰면 틀린다 | [markerContents/CheckPath](https://github.com/syncthing/syncthing/blob/516f3e29e8cc7091ea6271715308caea0fcc0778/lib/config/folderconfiguration.go#L198-L243); [공식 이동 FAQ](https://docs.syncthing.net/users/faq.html#how-do-i-rename-move-a-synced-folder) | 소스 확인; 이동 절차는 문서 주장 |
| <a id="E12"></a>E12 | Borg config에 난수 repo ID가 있고 누락 config는 InvalidRepository다. 별도 security 상태가 위치 이동 확인과 과거 manifest replay 검사를 맡는다. 복제본은 같은 ID이므로 물리 사본 두 개를 자동으로 구분하지 못한다 | [Repository.create](https://github.com/borgbackup/borg/blob/ecf2dfa1701eb3522e86a03a33bb9988eb7f959c/src/borg/repository.py#L297-L324), [open](https://github.com/borgbackup/borg/blob/ecf2dfa1701eb3522e86a03a33bb9988eb7f959c/src/borg/repository.py#L468-L497), [SecurityManager](https://github.com/borgbackup/borg/blob/ecf2dfa1701eb3522e86a03a33bb9988eb7f959c/src/borg/cache.py#L104-L155), [clone FAQ](https://borgbackup.readthedocs.io/en/stable/faq.html#can-i-copy-or-synchronize-my-repo-to-another-location) | 소스 확인; clone주의는 문서 주장・물리 사본 해석은 추론 |
| <a id="E13"></a>E13 | Borg는 inode를 파일 변경 cache에 저장한다. 새 disk/FS로 옮기면 inode가 바뀌므로 무시 후 cache를 갱신하는 이유를 코드가 명시한다. repo ID와 다른 용도다 | [file_known_and_unchanged](https://github.com/borgbackup/borg/blob/ecf2dfa1701eb3522e86a03a33bb9988eb7f959c/src/borg/cache.py#L1009-L1058) | 소스 확인 |
| <a id="E14"></a>E14 | GNU tar는 폴더 dev/ino와 이름을 incremental snapshot에 영속 기록해 rename/변경을 구별한다. NFS automount·LVM snapshot의 device 변화로 불필요 재백업이 생기며 --no-check-device 예외를 둔다. 테넌트 논리 신원 사례는 아니다 | [snapshot 쓰기](https://github.com/mirror/tar/blob/d479b2cc9160d9c2fb61afbc9ee70c2faadf80db/src/incremen.c#L1423-L1446), [비교](https://github.com/mirror/tar/blob/d479b2cc9160d9c2fb61afbc9ee70c2faadf80db/src/incremen.c#L525-L565), [공식 매뉴얼](https://www.gnu.org/software/tar/manual/html_node/Incremental-Dumps.html) | 소스 확인; 실패 상황은 문서 주장 |
| <a id="E15"></a>E15 | Windows file ID는 FS별 지원이며 시간에 따라 재사용/변경될 수 있다. ReFS의 64-bit file index는 유일성을 보장하지 않는다 | [Microsoft BY_HANDLE_FILE_INFORMATION Remarks](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information#remarks) | 문서 주장 |
| <a id="E16"></a>E16 | Docker cp CVE-2018-15664는 문자열 경로 해석과 실제 사용 사이 symlink 교체로 daemon이 host 권한으로 읽고 쓰는 문제다. 현재 Docker 취약 여부를 주장하는 근거가 아니다 | [발견자 Aleksa Sarai 공개 보고, 2019-05-28](https://www.openwall.com/lists/oss-security/2019/05/28/1) | 문서 주장 |
| <a id="E17"></a>E17 | K8s CVE-2017-1002101은 비신뢰 subPath를 kubelet가 host 권한으로 mount하는 문제다. 단계별 openat/fd 고정으로 보완했으나 CVE-2021-25741에서 mount 유틸의 재정규화가 fd 경계를 되돌렸다. 후자는 --no-canonicalize로 보완했다 | [Kubernetes 2018 공식 분석](https://kubernetes.io/blog/2018/04/04/fixing-subpath-volume-vulnerability/), [Google 발견팀 2021 분석](https://security.googleblog.com/2021/12/exploring-container-security-storage.html) | 문서 주장 |
| <a id="E18"></a>E18 | openat2 BENEATH는 dirfd 아래로 제한한다. IN_ROOT는 상대 root 의미를 적용하며 NO_MAGICLINKS·NO_XDEV는 별도 정책이다. Linux 실행에서 탈출은 EXDEV, 교체 전 보유 fd는 A, 교체 후 새로 연 fd는 B를 읽었다 | [openat2 매뉴얼](https://www.man7.org/linux/man-pages/man2/openat2.2.html); `probes/openat2-root-identity.py`, `openat2-run-log.txt` — Linux6.18 WSL2 x86_64/Python3.12.3 | 문서 주장 + 작은 probe 실행 확인 |
| <a id="E19"></a>E19 | Go Root의 Unix 구현은 parent fd+Openat/O_NOFOLLOW로 열고, Windows는 root handle+windows.Openat/O_NOFOLLOW_ANY·RootDirectory/NtCreateFile로 reparse link를 처리한다. 파일시스템 경계·bind mount·device까지 전부 막는 API는 아니다 | [Unix rootOpenFileNolog](https://github.com/golang/go/blob/3901409b5d0fb7c85a3e6730a59943cc93b2835c/src/os/root_unix.go#L77-L110), [Windows 구현](https://github.com/golang/go/blob/3901409b5d0fb7c85a3e6730a59943cc93b2835c/src/os/root_windows.go#L125-L169), [Root 계약](https://github.com/golang/go/blob/3901409b5d0fb7c85a3e6730a59943cc93b2835c/src/os/root.go#L33-L61) | 소스 확인; 계약 주석은 문서 성격 |
| <a id="E20"></a>E20 | securejoin 구 문자열 API의 검사 후 사용은 경로 교체에 안전하지 않다. 새 Linux API는 root fd를 받아 openat2 IN_ROOT/NO_MAGICLINKS로 handle을 얻는다 | [README 경고](https://github.com/cyphar/filepath-securejoin/blob/9e667cafd6b022fac5ae8711ace2204eeec95207/README.md#L6-L21), [lookupOpenat2](https://github.com/cyphar/filepath-securejoin/blob/9e667cafd6b022fac5ae8711ace2204eeec95207/pathrs-lite/internal/gopathrs/openat2_linux.go#L51-L59) | 문서 주장 + 소스 확인 |
| <a id="E21"></a>E21 | libpathrs는 root fd를 열어 보관하며 주석에서 공격자 소유 tree 안의 root 취득을 피하라 한다. 해당 판은 root 이동 후 SafetyViolation 정책도 명시한다. runc의 mountpoint 처리도 열린 root를 pathrs.OpenInRoot에 넘긴다 | [Root::open·계약](https://github.com/cyphar/libpathrs/blob/05a4b54f9843ea1fb0ae86dc2f40550bde244589/src/root.rs#L126-L185), [runc createOpenMountpoint](https://github.com/opencontainers/runc/blob/642809e5e24b8ddad48ed64085cf33b226befd8f/libcontainer/rootfs_linux.go#L535-L554), [OpenInRoot wrapper](https://github.com/opencontainers/runc/blob/642809e5e24b8ddad48ed64085cf33b226befd8f/internal/pathrs/root_pathrslite.go#L32-L44) | 소스 확인; libpathrs 안전/이동 주석은 문서 주장 |
| <a id="E22"></a>E22 | 조사한 Node fs.open/Promises.open 계약에는 dirfd가 없고 fs.md에서 동등 root API를 확인하지 못했다. #31110은 dirfd 제안, #65146은 Go Root 유사 제안으로 후자는 not planned로 닫혔다. Permission Model은 악성 코드 보장을 하지 않고 허용 경로의 외부 symlink도 따라간다고 명시한다 | [fs.md](https://github.com/nodejs/node/blob/c085224f33efd7938fb267efff52ddf41cad7a9a/doc/api/fs.md#L1787-L1812), [#31110](https://github.com/nodejs/node/issues/31110), [#65146](https://github.com/nodejs/node/issues/65146), [permissions 보장 한계](https://github.com/nodejs/node/blob/c085224f33efd7938fb267efff52ddf41cad7a9a/doc/api/permissions.md#L14-L22), [symlink 한계](https://github.com/nodejs/node/blob/c085224f33efd7938fb267efff52ddf41cad7a9a/doc/api/permissions.md#L542-L548) | 문서 주장; API 부재는 읽은 범위 한정 |
| <a id="E23"></a>E23 | Paseo는 같은 OS 계정이 0600 credential을 읽을 수 있어 신뢰 대상임을 명시한다. 연결된 client는 daemon 사용자 권한의 operator이며 workspace-relative 경로는 보안 경계가 아니라고 정한다 | [SECURITY Local daemon trust boundary](https://github.com/getpaseo/paseo/blob/66676d49e6336a75837abec247871553a7658c35/SECURITY.md#L47-L63) | 문서 주장 |
| <a id="E24"></a>E24 | OpenHands Docker runtime은 대화별 persistence/conversation/workspace subtree를 bind하고 runtime별 key, user·cap-drop·no-new-privileges를 설정한다. README는 중단/재개 때 host 상태 보존을 설명한다. host 부모 전체 변조 공격을 막는지는 읽은 범위에서 미확인 | [_build_container identity](https://github.com/OpenHands/software-agent-sdk/blob/2f2cd2bf7f19ca3bbf9f0c4a95c60f48094302a1/openhands-agent-server/openhands/agent_server/docker_runtime/registry.py#L607-L637), [mount/flags](https://github.com/OpenHands/software-agent-sdk/blob/2f2cd2bf7f19ca3bbf9f0c4a95c60f48094302a1/openhands-agent-server/openhands/agent_server/docker_runtime/registry.py#L668-L717), [README](https://github.com/OpenHands/software-agent-sdk/blob/2f2cd2bf7f19ca3bbf9f0c4a95c60f48094302a1/openhands-agent-server/openhands/agent_server/README.md#L454-L473) | 소스 확인; 생애주기는 문서 주장; host 위협은 미확인 |
| <a id="E25"></a>E25 | Paperclip은 앱 인가와 OS 파일 격리 책임을 구분한다. workspace bwrap은 tmpfs root에 선택 경로만 bind한다. low-trust 문서는 sandbox·private workspace를 요구한다. 이것을 모든 host 변조 방어 보장으로 확대할 근거는 없다 | [SPEC Filesystem access boundary](https://github.com/paperclipai/paperclip/blob/630ed6624c71c26617a1e0f3c5e97384ece2caae/doc/SPEC.md#L863-L876), [bwrap 구현](https://github.com/paperclipai/paperclip/blob/630ed6624c71c26617a1e0f3c5e97384ece2caae/packages/adapter-utils/src/local-process-sandbox.ts#L379-L412), [LOW-TRUST-PRESETS](https://github.com/paperclipai/paperclip/blob/630ed6624c71c26617a1e0f3c5e97384ece2caae/doc/LOW-TRUST-PRESETS.md#L130-L153) | 문서 주장 + bwrap 소스 확인; host 전체 방어는 미확인 |
| <a id="E26"></a>E26 | E2B는 sandbox별 Firecracker VM과 별도 kernel/filesystem/memory를, Daytona v0.227은 조직 인가 control plane과 sandbox 내부 daemon/compute plane 분리를 설명한다. Daytona 현 core는 비공개로 이동했으며 공개 백서 본문은 확보하지 못했다 | [E2B Security](https://e2b.dev/security), [Daytona Architecture](https://www.daytona.io/docs/architecture/), [공개 repo 안내](https://github.com/daytonaio/daytona/blob/ec4c21b2d597091ac09ecc278f3bcc172575a987/README.md#L1-L8), [Trust Center 공지](https://trust.daytona.io/?itemUid=71d7b6d9-19d2-4c3d-8210-6074745070ac) | 문서 주장; 실제 서비스·host 침해 모델 본문은 미확인 |
| <a id="E27"></a>E27 | Paperclip agent helper는 curl multipart로 file bytes+Bearer/run ID를 보낸다. 서버는 company 권한·issue 소속·agent/run context를 확인하고 file.buffer를 저장한다. uploader의 source host 경로를 서버가 여는 계약이 아니다 | [upload_file](https://github.com/paperclipai/paperclip/blob/630ed6624c71c26617a1e0f3c5e97384ece2caae/skills/paperclip/scripts/paperclip-upload-artifact.sh#L165-L204), [attachments POST](https://github.com/paperclipai/paperclip/blob/630ed6624c71c26617a1e0f3c5e97384ece2caae/server/src/routes/issues.ts#L19962-L20057), [교차회사 거부](https://github.com/paperclipai/paperclip/blob/630ed6624c71c26617a1e0f3c5e97384ece2caae/server/src/routes/authz.ts#L75-L79) | 소스 확인 |
| <a id="E28"></a>E28 | 위 업로드는 memoryStorage, 단일 파일·기본 10MiB 상한. 저장 key는 company prefix+namespace+random UUID이며 원래 이름은 별도 정보다. 저장소 영역은 여전히 보호해야 한다 | [parser](https://github.com/paperclipai/paperclip/blob/630ed6624c71c26617a1e0f3c5e97384ece2caae/server/src/routes/issues.ts#L4869-L4885), [상한](https://github.com/paperclipai/paperclip/blob/630ed6624c71c26617a1e0f3c5e97384ece2caae/server/src/attachment-types.ts#L159-L165), [key 생성·쓰기](https://github.com/paperclipai/paperclip/blob/630ed6624c71c26617a1e0f3c5e97384ece2caae/server/src/storage/service.ts#L60-L83) | 소스 확인; 보호 필요는 추론 |
| <a id="E29"></a>E29 | helper는 run+sha256+이름+MIME로 조회/재사용하고 불확정 응답이면 재조회 후 중단한다. 서버의 완전한 idempotency 계약은 아니다. 서버도 DB 등록 불확정 오류 시 이미 commit됐을 수 있어 저장 객체를 즉시 지우지 않는다 | [재시도 reconciliation](https://github.com/paperclipai/paperclip/blob/630ed6624c71c26617a1e0f3c5e97384ece2caae/skills/paperclip/scripts/paperclip-upload-artifact.sh#L427-L491), [등록 실패 처리](https://github.com/paperclipai/paperclip/blob/630ed6624c71c26617a1e0f3c5e97384ece2caae/server/src/routes/issues.ts#L20058-L20074) | 소스 확인 |
| <a id="E30"></a>E30 | MLflow는 HTTP artifact proxy와 presigned multipart 직접 업로드를 문서화했다. 직접 multipart는 payload가 서버를 지나지 않는다. 서버 credentials로 proxy할 때 권한 범위가 넓어질 수 있음을 별도로 명시한다 | [Tracking Server proxied access](https://mlflow.org/docs/latest/self-hosting/architecture/tracking-server/#using-the-tracking-server-for-proxied-artifact-access-default), [Artifact Stores multipart](https://mlflow.org/docs/latest/self-hosting/architecture/artifact-store/#multipart-upload-for-proxied-artifact-access) | 문서 주장 |
| <a id="E31"></a>E31 | E2B SDK는 file-like 입력이면 octet-stream 전송을 택해 buffering을 피하고 streamed request의 전체 deadline을 빼며 서버 idle timeout을 설명한다. 이것은 sandbox 안으로 파일을 보내는 방향이므로 산출물 수집 사례와 구별한다 | [Filesystem.write_files](https://github.com/e2b-dev/E2B/blob/9301cd84757b0e3f3fccbd349e85ff2bd403a1f4/packages/python-sdk/e2b/sandbox_sync/filesystem/filesystem.py#L359-L421) | 소스 확인; server idle timeout은 코드 주석의 문서 주장 |
| <a id="E32"></a>E32 | BaboJUBot은 이미 text content 직접 제출과 파일 path를 배타적으로 지원한다. 파일 상한은 10MiB, snapshot bytes는 base64다. 같은 호출 키 결과는 원본을 재읽기 전에 반환한다 | [recordArtifactInputSchema/ArtifactSnapshot](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/contracts/src/task.ts#L54-L83), [toolWrite replay](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/db/src/tool-calls.ts#L130-L146) | 소스 확인 |
| <a id="E33"></a>E33 | 제품 Claude transcript reader는 provider home의 파일명과 row.sessionId를 대조한다. 조사 중 별도 작업으로 생긴 Antigravity config helper의 babojubotOwner는 공통 형식 표식이며 조직/agent ID가 아니다. 이 두 표식을 조직 신원 인증으로 해석할 수 없다 | [claudeSessionFacts](https://github.com/babo-jeonguk/BaboJUBot/blob/9efe7f376badb9739b3d70443197c838abff3a6e/packages/runtime/src/providers/claude-transcript.ts#L7-L69), [Antigravity configScript(보조 열람판)](https://github.com/babo-jeonguk/BaboJUBot/blob/5c327a9030d283c3c738f0abbb11e111033bb0f1/packages/runtime/src/providers/antigravity-config.ts#L3-L41) | 소스 확인; 조직 인증 해석은 추론. Antigravity는 별도 보조 SHA |
| <a id="E34"></a>E34 | restic config에는 난수 ID가 있지만 읽은 LoadConfig는 load/version/polynomial 검사를 하며 외부 expected ID 인자를 받지 않는다. 자기 서술 ID와 기대 신원 대조는 별개다 | [Config/CreateConfig/LoadConfig](https://github.com/restic/restic/blob/7d0aa7f2e30546fba7c8f1c0bae4d6704e3d8423/internal/restic/config.go#L15-L87) | 소스 확인; 마지막 문장은 추론 |

### 현재 제품의 실패 원인과 적용 범위

**사용자의 직관은 디스크 쪽 결합 정보가 빠졌다는 범위에서 정확하다. 새 UUID를 추가하면 해결된다는 진단은 아니다.** DB의 조직·대화·agent는 이미 이름이 아니라 ID로 구분된다(E01). 빈 곳은 DB가 인증한 A와 이번에 연 폴더의 주장 ID를 대조하는 단계다(E02–E06). 외부 리뷰의 장면은 symlink가 없어도, 경합이 없어도 성립한다. root를 정확히 고정해도 그 root가 처음부터 B일 수 있다(E06/E18).

| 대상 | 현재 신원과 연결 | 같은 원인인가 | 필요한 범위 |
|---|---|---|---|
| 조직 workspace | DB org UUID → 경로의 UUID 문자열 | 그렇다. 온전한 B 폴더가 A 자리에 오면 구별 정보가 없다 | 폴더의 논리 ID 대조 + 같은 root에서 읽기(E02/E03/E06) |
| agent 개인 폴더 | DB agent/org UUID → agents/<agent UUID> | 폴더 신원 결합의 공백은 같다. 다만 record_artifact는 이 개인 폴더를 읽는 경로가 아니다 | 서버가 개인 폴더 귀속을 믿는 동작에는 org+agent 쌍 검증 확장. 에이전트가 쓸 수 없는 부모 쪽 메타데이터에 둔다(E01/E02; 제안은 추론) |
| 제품 대화·메시지·활동·산출물 기록 | DB UUID·조직 조건·FK와 run 주체 | 읽은 DB 경로에서는 같은 폴더 바꿔치기 원인이 아니다. 대화 폴더를 제품 DB 신원으로 쓰지 않는다 | 기존 DB 경계 유지. 모든 기록에 무차별 marker 추가 근거 없음(E01/E04/E05) |
| provider native session·transcript·작업 설정 | DB session state와 연결별 provider home, 내용의 sessionId/공통 소유 표시 | 파일 기반 상태를 읽는 곳은 경로/내용 변조 문제가 가능하다. 제품 대화 DB와 동일 구조라고 단정할 수 없다 | 별도 신뢰 영역·session binding 감사가 필요. 이번 조사로 모든 adapter의 교차 조직 취약 여부를 판정하지 않음(E05/E33) |

현재 같은 OS 계정으로 임의 코드를 실행하면 폴더 지침·0600 모드만으로 서버 소유 영역과 에이전트 영역을 나눌 수 없다. [구조 문서의 사용자 API 신뢰 경계](../architecture.md#제품-불변-조건-강제-위치)도 이를 인정한다. **이것은 폴더 식별 누락보다 넓은 실행 격리 문제**다. A marker를 복사/수정하거나, marker를 둔 채 shared만 바꾸거나, B 내용을 A 파일에 복사하면 marker는 내용 출처를 입증하지 못한다(E06/E23/E25; 추론).

### Q1: 자기 서술 폴더·이동·복원의 의미

| 사례 | 식별 위치·비교 상대 | 없거나 틀리면 | 이동·복원에서 확인한 것과 한계 |
|---|---|---|---|
| Kafka | logDir/meta.properties의 cluster/node/directory ID | KRaft의 metadata 누락/설정 node 불일치/중복 directory ID 거부 | 소스 오류 안내가 data 이동 시 nodeId 일치를 요구한다. 경로 이름이 신원이 아니다. 전체 backup 실행은 미확인(E07) |
| MinIO | .minio.sys/format.json의 deployment·drive/set UUID | 누락은 unformatted, set 배치/This 불일치 거부 | drive 번호와 디스크 내 ID를 대조하는 패턴. 이후 init/heal 전체와 이동/복원 운영은 미확인(E08) |
| PostgreSQL | pg_control system ID와 WAL/복제 상대 | control 읽기/CRC 오류, 다른 계보 WAL/primary 거부 | 물리 복제·백업 계보는 같은 ID를 보존한다. 일관된 전체 복원이 필요하며 inode를 유지할 필요로 해석하지 않는다(E09/E10; 이동성 판단은 추론) |
| Borg | repository config ID + 별도 security 상태 | config 누락 거부, 위치 변화 확인·과거 manifest 거부 | 동일 repo 이동은 별도 위치 승인으로 다룬다. clone은 같은 ID이므로 독립 사용 위험이 있고 과거 복원은 replay와 구별해야 한다(E12) |
| Syncthing | .stfolder 존재 | 없으면 marker missing | 이동은 중지/설정 변경 절차를 문서화한다. 다른 folderID를 거부하는 인증은 아니다(E11) |
| restic | repository config ID | 읽기/형식 검사 오류. 기대 외부 ID 불일치의 전면 정책은 읽은 함수로 미확인 | 자기 서술·캐시 분리의 보조 사례이며 DB와 매번 대조하는 구현으로 인용하지 않는다(E34) |
| GNU tar / Borg cache | snapshot의 폴더 dev/ino / 파일 cache inode | 변경 또는 rename으로 분류하여 재백업 | 실제 번호 저장 사례는 있다. 영속 테넌트 신원과 용도가 다르고 이동/복원·FS 차이 예외가 있다(E13–E15) |

C의 ID가 보존된 A 백업 두 개는 **같은 논리 조직의 두 사본**이다. 복원이 가능한 설계에서는 inode가 달라도 A로 인정해야 한다. “어느 사본이 최신인가”, “두 독립 조직으로 fork했는가”, “이 파일은 누가 생산했는가”는 marker ID와 다른 질문이며 버전/복원 절차·새 조직 import·실행 출처 기록이 필요하다(E10/E12/E06; 추론). Ceph/CockroachDB/Elasticsearch/Gitaly는 후보 기록만 남기고 세부 거부·복원 동작을 결정 근거로 쓰지 않았다.

### Q2: 대리 읽기는 무엇을 보장해야 하는가

1. run token·DB scope로 **기대한 조직 A**를 정한다(E04).
2. 선택한 폴더 객체를 붙잡고 **그 폴더의 논리 ID가 A인지** 확인한다(E07–E09에서 도출한 제품 적용 추론).
3. 검사한 그 root를 유지한 채 **비신뢰 하위 경로가 root 밖으로 나가지 않게** 파일을 열고, 이후에도 경로 문자열로 다시 열지 않는다(E16–E21).

현재 dev/ino 비교는 3의 일부이고 2를 하지 않는다. openat2·Go Root·securejoin도 “기대한 조직 ID”를 자동으로 알지 못한다(E03/E18–E21). root ID 검사 뒤 절대 경로로 다시 진입하면 고정이 끊겨 CVE와 같은 검사/사용 분리가 재도입된다. marker도 symlink/특수 파일·과도한 크기·동시 수정으로 우회할 수 없게 같은 고정 root에서 읽어야 한다(추론: E16–E21).

이식성 때문에 Linux openat2 하나를 제품 전제로 삼지 않는다. Go는 Unix/macOS 계열과 Windows를 다른 API로 구현하고, Windows reparse/device/volume 경로 의미도 따로 다룬다(E19/E15). Node 공식 문서와 제안에서는 곧바로 쓸 동등 API를 확인하지 못했다(E22). 현재 보조 프로세스 seam을 강화할지, 별도 portable helper/native binding을 둘지는 후속 구현의 선택이다. 이번 Linux probe가 현재 chdir 방식의 Windows/macOS race 안전성을 검증한 것은 아니다. libpathrs의 root 이동 거부 정책도 사용자 요구와 대조 없이 그대로 가져오면 안 된다(E21; 추론).

### Q3: 제품들이 두는 신뢰 경계

| 제품 | 테넌트 영역과 서버/운영 영역 | 서버 소유 영역을 바꿀 수 있는 공격자 |
|---|---|---|
| Paseo | daemon 사용자 권한이 기준. workspace 경로는 UI 편의 | 동일 계정 프로세스는 명시적으로 신뢰 대상. 이를 적대적 멀티 테넌트 격리 사례로 쓸 수 없음(E23) |
| OpenHands | Docker 모드에서 대화별 실행·부분 subtree bind, host에 상태 보존 | 읽은 registry/README에서 host 부모 전체 변조 방어와 완전한 위협 모델은 미확인(E24) |
| Paperclip | 회사/task/run 앱 인가와 OS 파일 격리를 구분. 선택 sandbox와 low-trust 정책은 별도 | OS/환경이 경계를 맡는다는 문서는 명시. host storage 원본 임의 변조까지 방어한다는 주장은 확인 못 함(E25) |
| E2B | 문서상 sandbox별 VM·별도 kernel/FS/memory | guest 실행 격리 문서만 확인. host/control plane 장악 후 귀속 검증은 미확인(E26) |
| Daytona | 문서상 API 조직 인가·metadata와 sandbox 내부 daemon/compute 분리 | 현 private core·공개 위협 모델 백서 본문을 확보하지 못해 포함/제외 모두 미확인(E26) |

따라서 “다른 제품도 server-owned라 쓰니 A만 선언하면 안전하다”는 결론은 성립하지 않는다. 신뢰 모델을 명시하는 것과 그 부모 영역을 실제 쓰기 불가능하게 만드는 것은 구별해야 한다. 컨테이너를 쓰더라도 DB·marker·다른 조직·container socket 등을 노출하면 경계가 달라지므로 구체 mount/권한·네트워크 구성을 확인해야 한다(E23–E26; 추론).

### Q4: 내용 업로드로 바뀌는 것

Paperclip은 실제 agent 산출물 업로드 사례다(E27–E29). MLflow도 클라이언트가 보낸 산출물을 proxy하거나 presigned URL로 저장소에 보내는 구성을 문서화했다(E30). E2B SDK 전송은 **sandbox 안으로 보내는 방향**이어서 산출물 수집의 직접 사례로 세지 않는다(E31).

| 항목 | 현재 서버 경로 읽기 | 내용 업로드 |
|---|---|---|
| 원본 읽는 주체 | 서버가 자기 OS 권한으로 source path를 연다 | agent/격리된 helper가 자기 권한으로 읽어 전송. 서버는 source host path를 몰라도 됨 |
| 조직 귀속 | token scope + 올바른 root 선택 + 경로 경계 | token scope + 목적 task/artifact 권한. body의 orgId나 업로드 파일 이름은 신뢰 근거 아님 |
| 크기·운송 | 현재도 Buffer·자식 stdout·base64와 DB 저장 비용, 10MiB 상한 | HTTP/IPC 복사 추가. base64는 원본 대비 약 4/3 크기(인코딩 산술). multipart binary는 이를 피하나 memoryStorage는 동시 요청 수에 비례해 메모리 소비. 큰 파일은 stream/backpressure·총량·idle timeout 또는 scoped presigned multipart 검토 |
| 재시도 | 현재 같은 호출 키는 기존 snapshot 재사용 | 같은 키+내용 digest·등록 receipt가 필요. response 유실/중복·임시 객체·DB/object commit 불확정을 분리. Paperclip client 재조회만을 exactly-once 보장으로 오인하지 않음 |
| 권한·내용 출처 | 서버의 권한 대리가 공격 표면 | 대리 source 읽기는 제거. 같은 계정 agent가 B를 읽어 A token으로 올리면 API는 출처를 증명 못 함. storage/DB 자체 보호도 계속 필요 |
| 이동·원격 실행 | source 파일이 서버의 FS view에 있어야 함 | agent와 서버의 절대경로가 달라도 가능. 등록된 DB와 저장 객체의 일관 backup은 여전히 필요 |

표의 제품 사실은 E03/E04/E27–E32, 비용·설계 판단은 이 근거에서의 추론이다. 현재 텍스트 content 직접 제출은 이미 D의 작은 형태지만 바이너리 업로드 계약 전체가 구현됐다는 뜻은 아니다(E32).

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 데이터와 함께 논리 ID를 저장하고 외부 기대값/다른 구성요소와 비교 | E07–E10/E12/E34 | 기대값 출처는 config·다른 logDir·WAL·복제 상대 등. 모두 DB UUID 비교는 아님 | 경로 이름과 데이터 계보를 구별, copy/복원과 양립 | 기대값 대조 없는 marker 존재만으로 부족. 수정 가능한 marker는 인증 못 함(E06/E11) |
| <a id="P02"></a>P02 | root를 고정하고 검사·사용 전체에서 handle/cwd 연속성 유지 | E16–E21 | Linux syscall·Go의 OS별 API·현재 Node helper | 하위 symlink/rename 검사 후 교체 방어 | root를 잘못 골랐다면 안전하게 B를 읽음. downstream 경로 재해석도 위험 |
| <a id="P03"></a>P03 | 논리 ID와 별도로 OS/실행환경이 서버 소유 영역을 보호 | E23–E26 | 로컬 신뢰·컨테이너·VM을 동일 보장으로 취급하지 않음 | 테넌트가 marker·부모·다른 조직을 직접 바꾸지 못하게 함 | 환경 설정·mount/권한 검증 비용. 동일 UID unrestricted 상태는 이 보장이 없음 |
| <a id="P04"></a>P04 | 파일 번호는 열린 객체 비교/변경 cache로 제한 | E03/E06/E13–E15 | tar는 폴더 번호도 영속 저장하나 백업 변경 탐지용 | 호출 중 객체 교체 감지에 유용 | DB 영속 신원으로 삼으면 복원/FS 변화 오탐, 번호 재사용/내용 교체 미탐 |
| <a id="P05"></a>P05 | 원본 경로 대신 인가된 bytes를 서버 소유 저장소로 제출 | E27–E32 | small buffered upload / stream / presigned multipart | source 대리 읽기를 제거, 원격 실행에 자연스러움 | 크기·재시도·목적 저장소 권한 문제는 남고 uploader의 타 조직 직접 읽기를 막지는 못함 |

## 결정 권고

**권고안 하나: C를 변형 채택한다.** 조직 폴더의 서버 관리 영역에 논리 조직 ID를 보존하고, 고정한 동일 root에서 기대 ID 대조와 산출물 읽기를 연결한다. 신규·이관·복원 규칙을 함께 둔다. 이는 경로 이름만 신뢰하는 누락을 메우는 일관성 검증이다. **적대적 agent 격리까지 완성하려면 marker와 그 부모·DB를 agent가 수정하지 못하도록 실제 실행 경계가 필요하다. 현재 동일 OS 계정 무제한 실행에서 C만으로 조직 분리가 강제됐다고 보고해서는 안 된다.** 권고는 P01/P02/P03에서 도출한 추론이며 upstream 그대로의 구현 계약이 아니다.

UUID 경로 레이아웃은 locator로 계속 쓸 수 있다. `{version: 1, organizationId: <DB UUID>}`처럼 최소한의 서버 작성 메타데이터로 충분한 출발점이 되며 표시 이름·절대경로·영속 inode는 넣지 않는다. 파일명은 예시로 `organizations/<UUID>/workspace-identity.json`, 위치는 `shared` 밖이다. 별도 폴더 인스턴스 UUID를 추가하는 것은 사본 동시 사용을 별개로 다룰 필요가 생겼을 때 결정하며 새 UUID 자체가 보안 해법은 아니다(추론: E01/E06/E12).

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | **변형 채택** | C: 서버 작성 ID metadata + 같은 root 고정/검증/읽기 + fail closed + 이관 규칙 | P01/P02, E06/E07 | 온전한 B→A·organizations tree 교체에서 B marker를 거부하고 정상 A 이동/복원은 허용. 파일 한 개·검사 I/O·생애주기 처리 추가. marker를 고치는 공격자/부분 내용 교체에는 단독 방어 아님 | Q1/Q2 |
| <a id="D02"></a>D02 | 부분 채택, **A 단독은 배제** | 서버/agent 영역 신뢰 계약은 명시하되 문서만으로 문제 해결 처리하지 않는다 | P03, E02/E06/E23–E26 | 최소 변경이지만 현 재현은 그대로 통과. 악의 없는 운영 실수조차 검출 못 함. 공격자 모델이 같은 UID를 포함하면 실제 권한 분리가 별도 필요 | Q2/Q3 |
| <a id="D03"></a>D03 | **B 영속 식별은 배제** | dev/ino는 호출 중 고정/대조에만 사용 | P04 | 미리 저장하면 온전한 B 교체는 검출 가능. 그러나 cp·파일 단위 복원·다른 FS는 정상 A도 거부, Windows ID도 제약. 자동 재등록은 B를 A로 등록할 수 있음. root inode를 유지한 내용 교체는 통과 | Q1/Q2 |
| <a id="D04"></a>D04 | 보류 | D: 바이너리 포함 bytes 업로드를 장기 artifact transport 대안으로 유지 | P05 | source 경로 대리인을 제거하는 더 강한 문제 축소. API·MCP/CLI helper·용량/재시도·저장 계약 변경이 크고 forRun/개인 폴더 정체는 남음. 현재 동일 계정의 B 직접 읽기도 남으므로 이번 identity 권고의 대체 완료 근거는 아님 | Q2/Q4 |
| <a id="D05"></a>D05 | **E 단독 해법은 배제** | folder path DB 저장은 필요하면 locator 확장으로만 | E02/E06, P01/P02 | DB가 A→/x라 해도 /x를 B로 바꾸면 동일 실패. 절대경로 저장은 data root 이동시 매핑 수정 비용. 임의 폴더명 요구가 생기면 상대 locator+ID검증 조합 가능 | Q1/Q2 |
| <a id="D06"></a>D06 | 변형 채택 | 추가 F: 서버 소유 parent/metadata를 실제 격리하고, 검증한 root 참조를 실행/읽기 seam이 일관되게 사용 | P02/P03, E18/E24/E25 | C의 보안 전제. OS 계정·ACL·컨테이너/VM 중 구현에 맞춰 선택, host 전체/DB/다른 조직을 agent에게 주지 않음. handle만 유지하면 재시작 후 정체·복원 문제는 남아 C와 함께 필요 | Q2/Q3 |

### C의 생성·이관·복원 규칙

다음은 제품 적용을 위한 **추론/권고**이며 검증된 제품 구현이 아니다(E02/E06–E12/E16–E21).

1. **신규 생성:** DB 조직 ID로 새 서버 관리 폴더와 marker를 만든다. 기존 파일을 무조건 덮지 않고 배타적 생성·임시 파일/원자 공개·형식 버전을 사용한다. DB commit과 filesystem은 한 트랜잭션이 아니므로 중간 실패를 `준비 중/복구 필요`로 재시도할 수 있어야 한다. 새 폴더인지 확인 안 된 기존 데이터에 기대 ID를 찍지 않는다.
2. **사용:** run 주체의 org ID를 기대값으로 고정한다. 조직 root에 들어가 고정한 후 marker를 크기 제한 있는 정규 파일로 읽어 정확히 대조하고, 같은 고정 root의 shared에서 파일을 연다. marker를 읽고 상위 절대경로로 재진입하지 않는다. 실행 요청용 workspace 준비/전달도 같은 조직 정체 검증을 거쳐야 한다. artifact 읽기만 검사하면 실행에는 B workspace를 줄 수 있다.
3. **누락/손상/불일치:** 이미 등록된 조직이면 `workspace_identity_missing/invalid/mismatch` 같은 구별 가능한 상태로 해당 조직의 새 실행·파일 등록을 거부하고 관찰 가능하게 보고한다. 다른 조직은 계속 운영한다. ID를 기대값으로 조용히 고치지 않는다. marker 도입 전 legacy 여부는 marker의 부재가 아니라 서버 관리 migration 상태에서 정한다.
4. **기존 폴더 이관:** writer와 새 실행을 멈추고 DB 목록·폴더 목록·백업을 대조한다. 원래 ID 정보가 없는 비어 있지 않은 폴더의 진짜 귀속을 경로만으로 사후 증명할 수는 없다. 사용자가 현재 매핑을 신뢰한 일회성 bootstrap 또는 검증한 백업에서의 복원을 선택하게 하고 근거·대상·완료 상태를 남긴다. 모든 missing marker에 매 시작/읽기마다 자동 발급하는 이관은 금지한다. 중간 중단 뒤에도 이관되지 않은 조직만 보류하며 엉뚱한 폴더를 덮지 않아야 한다.
5. **이동/복원:** writer 정지/일관 snapshot으로 DB와 조직 데이터·marker를 함께 보존한다. 서버 data root가 달라져도 상대 layout과 org ID가 맞으면 새 위치에서 root를 다시 열 수 있어야 하며 inode 재승인을 요구하지 않는다. 이동 후 기존 handle을 계속 쓸지 요청을 다시 시작할지는 OS별 정책으로 검증한다. 오래된 백업의 같은 ID는 최신성 증명이 아니며, 다른 조직으로 fork/import할 때는 DB 참조와 marker를 함께 새 신원으로 변환하는 명시 절차가 필요하다.
6. **agent 확장:** 개인 폴더도 서버가 귀속을 믿는다면 org+agent ID로 결합한다. agent에게 개인 폴더 전체를 쓰기 mount한다면 그 안의 marker도 쓸 수 있으므로, 부모의 서버 관리 표/sidecar에 두거나 쓰기 대상과 분리한다. 대화·메시지 DB 행에는 현재 파일 marker를 추가할 이유가 없다.

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 존재 마커를 ID 대조라고 부름 | Syncthing E11 | B의 marker도 존재하므로 A/B 구별 못 함 |
| 경로 정규화·inode 비교 횟수만 늘림 | E03/E06/E16/E18 | 정확히 고른 B 객체임만 확인. 기대 A라는 결합 정보가 생기지 않음 |
| marker 없으면 현재 경로 이름을 적어 자동 복구 | C의 단순 이관안 | B→A 후 marker 삭제로 A 표식을 발급받을 수 있음. 과거 귀속 정보도 없음 |
| 서명/비밀 nonce를 marker에 넣으면 모든 문제 해결 | E06/E12/P03의 추론 | key가 같은 UID에 있으면 보호가 안 되며, key를 분리해도 정상 A marker를 유지한 B shared 혼합은 인증하지 못함. 내용 인증·출처는 별도 계약 |
| 업로드면 조직 격리가 자동 완성 | E23/E27–E30 | 대리 읽기는 없어지지만 uploader가 읽을 수 있는 B bytes와 서버 저장소 변조는 남음 |

## 구현 참고

- 권고 요약: 논리 ID를 폴더 메타데이터에도 남겨 검증하고, 검사한 root를 끝까지 유지한다. 영속 identity는 portable metadata, 호출 중 객체 고정은 OS handle/cwd, 테넌트 경계는 실제 실행 격리가 맡는다(D01/D06).
- 구현 위치: [구조 문서](../architecture.md)의 Control Plane 서버 workspace seam인 `apps/server/src/workspace.ts`의 ensure/forRun/readArtifact, `run-request.ts`·`after-commit.ts`의 준비/복구 흐름. metadata 이관 상태·진단을 어디 저장할지는 후속 구현에서 정한다. OS 파일 처리 코드를 domain core로 끌어올리지 않는다.
- DB 조직/agent/session FK·run token 인가·artifact snapshot/replay는 유지할 계약이다(E01/E04/E32). D를 별도 채택하면 contracts/transport와 업로드 receipt·storage 계층까지 범위가 커진다.
- 현재 폴더 자동 복구는 mkdir 중심(E02)이다. marker 도입 후 “빈 폴더 재생성”과 “정체 불명 기존 데이터 접수”를 구분하도록 복구 규칙을 함께 바꿔야 하며 조용히 기존 동작과 같다고 하지 않는다.

아래는 **후속 구현에서 검증할 시나리오**다. 이번에 통과한 제품 테스트 목록이 아니다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 정상 A root/marker/파일 → 실행 준비·등록 → A bytes와 A 주체 기록 | D01/E04 |
| V02 | B 폴더 전체를 A 이름으로 rename → forRun/readArtifact → mismatch, 실행·등록 없음 | D01/E06 |
| V03 | organizations 또는 data root 상위 경로 교체 → 새로 연 A 위치의 B marker → 거부 | D01/E06/E18 |
| V04 | marker 검사 뒤 ancestor/조직/shared의 rename·symlink 경합 → 같은 root에서 사용 → 검증했던 객체 또는 명시 실패, 새 B 경로 재해석 없음 | D01/D06/E17–E21 |
| V05 | missing/JSON손상/다른 버전/다른 org ID/marker symlink·특수 파일·과대 파일 → 사용 → 조직별 거부, 타 조직 계속 | D01/E07–E09 |
| V06 | 다른 절대경로·공백/한글 경로의 정상 A 이동, cp/backup 복원으로 새 inode → 일관 DB+marker 로드 → 승인된 A로 정상 사용 | D01/D03/E06/E10 |
| V07 | 비어 있지 않은 legacy 폴더 또는 marker 삭제 → 시작/읽기 → 자동 재발급 안 됨; 일회 이관의 중단/재시작은 등록 상태로 구분 | D01, 이관 규칙 |
| V08 | server marker/parent·DB·B 조직 접근을 A agent가 시도 → 격리 실행 → 쓰기/읽기 거부. 동일 UID unrestricted 모드 대조군은 보장 밖임을 보고 | D06/E23–E26 |
| V09 | agent X 개인 폴더를 Y 위치로 교체 → org+agent 귀속을 쓰는 동작 → 불일치 거부. DB 대화명 변경은 기존 UUID/조직 FK 유지 | D01/E01/E02/E05 |
| V10 | 파일 등록 뒤 원본 삭제/변경·동일 호출 키 재시도·서버 재시작 → 기존 snapshot 반환 → 파일 재읽기·중복 Event 없음 | E04/E32 |
| V11 | Linux/macOS/Windows의 symlink/reparse·UNC/volume/device·long path·지원 FS별 고정/이동 정책 → 정상 경로는 허용, 탈출·오인 거부 | D01/D06/E15/E19/E22 |
| V12 | D 채택시 A token+B task/org, 큰/빈/동시 전송, 응답 유실·DB/object commit 불확정 → 인가·용량·idempotency·복구 정책대로 처리 | D04/E27–E32 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 동일 UID 로컬 모드의 제품 보장과 격리 적용 시점 | 사용자·격리 실행 #102 | 로컬 신뢰 한계 명시 vs 적대 agent용 실제 격리 필수. marker로 대신할 수 없음(D02/D06) |
| legacy 매핑 신뢰/빈 workspace 재생성/이전 백업 복원 승인 절차 | 사용자·후속 구현 담당 | 기존 데이터는 귀속 증명 정보가 없으므로 일회 bootstrap 또는 검증한 백업 복원. 안전한 빈 신규 생성과 구분(D01) |
| OS 파일 처리 backend | 후속 구현 담당 | 기존 child-process seam 강화 vs portable helper/native binding. Go는 비교 근거이며 언어 변경 권고가 아님(E19/E22) |
| agent 개별 폴더 결합 및 binary upload 전환 범위 | 사용자·후속 구현 담당 | 조직 marker 우선 후 개인 폴더 server metadata 확장, D는 별도 transport 변경(D01/D04) |

## 한계와 미확인

- **실행 확인:** 키 없는 셸에서 `env -i PATH="$PATH" node .reference-cache/workspace-identity/probes/identity.mjs`와 `env -i PATH="$PATH" python3 .reference-cache/workspace-identity/probes/openat2-root-identity.py`. 앞쪽은 제품 pinnedReader와 preflight를 fixture에 실행한 파일 경계 확인, 뒤쪽은 Linux openat2 작은 syscall probe다. DB/API 전체·실제 C 구현·동시 race를 실행한 것이 아니다. 로그와 probe를 cache에 보존했고 fixture는 정리했다.
- **소스 확인:** 위 고정 SHA의 선택 파일·호출 경로·거부 분기를 읽었다. Kafka·Go·Paperclip 일부 테스트도 읽었지만 실행하지 않았다. 제품 테스트·upstream 서비스·실제 모델·업로드 서버·백업/복원 통합 실행은 하지 않았다.
- **미확인:** Windows/macOS의 현재 Node chdir/helper 안전성, reparse/ACL/네트워크 FS·inode 재사용 스트레스, 구현될 C의 crash/동시성, 모든 provider native session의 악의적 변조, 실제 격리 환경의 host 부모 변경 방어.
- **자료 제한:** Ceph/CockroachDB/Elasticsearch는 후보 문서까지만, Gitaly 이슈 본문은 확보 실패. Daytona private core·위협 모델 whitepaper 본문은 공개 페이지 접근 실패/403, E2B 상세 감사/pentest는 NDA·계정 경로라 미열람. 이를 “공격자를 위협 모델에서 제외한다”는 부재 주장으로 바꾸지 않는다. GNU libc 원문은 timeout, POSIX sys_stat 원문은 403이라 결정 근거에서 제외했다.
- **작업 트리:** 조사 중 다른 작업으로 `packages/runtime/src/providers/antigravity.ts` 수정과 `antigravity-config.ts` 추가가 나타났다. 이 조사에서는 읽기만 했고 수정·되돌리기하지 않았다. 해당 별도 변경은 조사 종료 시 `5c327a9030d283c3c738f0abbb11e111033bb0f1`로 기록되어 E33만 그 보조 SHA를 인용했다. 핵심 workspace.ts와 schema.ts·Claude transcript는 최초 기준 SHA와 차이 없음을 재확인했다.
- upstream HEAD·공식 웹 문서는 바뀔 수 있다. 재구현 때 버전·거부 경로·OS 지원을 다시 확인한다. 코드 재사용을 권고하지 않았으므로 제품에 외부 소스를 복사하거나 THIRD_PARTY_NOTICES를 변경하지 않았다.

| 단계 | 상태 | 근거 |
|---|---|---|
| Brief | 완료 | Q1–Q4, 고정 결정과 기존 조사 재사용 판단 |
| Discovery | 완료 | 관점별 라운드·saturation·후보별 실행 경로를 candidates/notes에 기록 |
| Recon | 완료(명시한 범위) | 고정 SHA·라이선스·메인 원문 재열람, 소스/문서/실행 구분. 미확인은 위에 명시 |
| Synthesis | 완료 | P01–P05, D01–D06, A–E 실패/비용·이관·보안 전제·열린 결정 |
| Receipt | 완료 | 이 문서와 `.reference-cache/workspace-identity/receipt.md`. 사용자 지시로 외부 댓글·이슈 게시 없음 |

문서 검사 결과는 `.reference-cache/workspace-identity/verification.md`에 기록한다. 제품 구현·테스트 통과나 최종 제품 결정을 뜻하지 않는다.

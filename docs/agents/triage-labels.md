# Triage labels

mattpocock/skills의 역할 이름과 이 저장소의 실제 label은 같습니다. 이슈마다 category 1개와 state 1개를 붙입니다.

| 묶음 | label | 의미 |
| --- | --- | --- |
| category | `bug` | 깨진 동작 |
| category | `enhancement` | 새 기능·개선 |
| state | `needs-triage` | 관리자의 평가 필요 |
| state | `needs-info` | 제보자의 추가 정보 대기 |
| state | `ready-for-agent` | 명세가 충분해 AFK agent 구현 가능 |
| state | `ready-for-human` | 사람의 구현 필요 |
| state | `wontfix` | 진행하지 않음 |

그 밖의 label(`priority:*`, `research-required`, `foundation`, `feature`, `orchestration`, `research-harness`, `wayfinder:*`, GitHub 기본 label)은 선택 표시이며 category·state를 대신하지 않습니다. `bug`를 `ready-for-agent`로 옮기기 전에 고칠 경계, 입력·상태별 기대 동작, 이번에 확인할 플랫폼을 이슈나 Agent Brief에 적습니다.

skill이 역할을 지시하면 이 label을 씁니다. 조작 명령은 [이슈 운영](issue-tracker.md)을 따릅니다.

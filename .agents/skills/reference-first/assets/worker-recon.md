BaboJUBot <key>의 reference-first Recon 중 <레퍼런스>(<repo URL>@<SHA>)를 맡는다. 작업 디렉토리: <repo root>

[brief]
<구현할 문제 / 동종 문제 / 조사 질문 — 요약하지 않은 원문>

[할 일] .agents/skills/reference-first/references/recon.md 의 <Source Recon | Behavioral Recon | Self-host> 절을 따른다.
볼 메커니즘: <질문과 연결된 메커니즘>.

[메모] .reference-cache/<key>/recon/<레퍼런스-slug>.md 에 한국어로:
- 고정 SHA, 확인일, root LICENSE
- 호출 경로 사슬(파일:심볼)
- 관찰마다 한 행: | 관찰 | permalink(#L 범위) | 심볼·테스트 | 수준 | 답하는 질문 |
- 실패 경로와 테스트가 다루지 않는 경우
- 실행했다면 명령·버전·결과, 못 했다면 이유. self-host 기록은 recon.md 「Self-host」의 기록 경로에 둔다

[경계] .reference-cache/와 /tmp/reference-selfhost/<slug>/ 밖은 쓰지 않는다. 의존성 설치는 lifecycle script를
끄고, 키 없는 셸에서만 실행한다. 띄운 프로세스는 보고 전에 그 PID로 끈다.

[보고] 짧게: 질문별 답과 permalink, 반례·실패 모드, 미확인 범위.

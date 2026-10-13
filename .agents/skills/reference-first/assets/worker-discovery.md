BaboJUBot <key>의 reference-first Discovery 중 <관점> 관점을 맡는다. 작업 디렉토리: <repo root>

[brief]
<구현할 문제 / 동종 문제 / 고정된 결정 / 조사 질문 — 요약하지 않은 원문>

[이미 아는 후보 — 중복 조사하지 않는다]
<기존 조사와 다른 관점의 후보 이름>

[할 일]
1. <관점>에서 동종 문제를 푼 프로젝트·라이브러리·서비스·명세·논문을 찾는다. 목표 개수는 없다. 라운드마다
   검색 경로를 넓힌다: awesome list, GitHub topic, 심볼·오류 메시지 code search, alternatives·비교 글, 후보의
   의존성과 사용처, 논문 related work·인용, issue·discussion·PR, 패키지 레지스트리.
2. 마지막 라운드의 새 후보가 어떤 질문에도 새 패턴·변형·실패 모드를 더하지 않으면 멈춘다.
3. 관련도가 높은 후보는 핵심 위치를 고정 SHA permalink(`blob/<40자 SHA>/<path>#L..`)로 찾아 둔다. SHA는
   `gh api repos/<o>/<r>/commits/HEAD --jq .sha`, 파일은 `gh api` raw로 읽는다.

[메모] .reference-cache/<key>/notes/<관점-slug>.md 에 한국어로. 진행분을 먼저 기록하며 쓴다.
| 후보 | 공식 URL | 분류 | 확인일 | 근거 수준 | 운영 상태·라이선스 | 답하는 질문 | 패턴·반례 | 핵심 위치 |
근거 수준: 실행 확인 / 소스 확인 / 문서 주장 / 검색 결과만 / 접근 불가. 주장마다 1차 출처를 단다. 찾지 못한
기능을 「없음」으로 적지 않는다. 끝에 라운드별 검색 경로와 새 후보를 적는다.

[경계] .reference-cache/ 밖은 쓰지 않는다. 로그인·유료 API·자격 증명이 필요한 경로, 패키지 설치, 외부 코드
실행은 하지 않는다.

[보고] 짧게: 후보 수, 가장 강한 패턴 3–5개와 permalink, 심층 조사 추천 2–3개와 이유, saturation 근거,
접근하지 못한 자료.

# 조사 전략

## Issue 성격별 방법

| Issue 성격 | 주 방법 | 반드시 볼 것 |
|---|---|---|
| UI/UX | Surface Capture + Behavioral Recon | 상태별 화면(빈·로딩·실패·권한 없음)과 전이, 좁은 폭 |
| 실행·스케줄링·동시성 | Source Recon + runtime/failure | 상태 전이, claim·lease, timeout·재시도·취소, 중복 실행, 종료 뒤 복구 |
| 보안·권한·조직 격리 | Source Recon + adversarial scenario | 검사 위치, 우회 경로, 교차 조직 참조, 귀속 누락, 신뢰 경계 |
| 저장·기억 | Source Recon + persistence/recovery | 스키마·migration, 원자적 쓰기·트랜잭션, crash 뒤 복구, 삭제·공유 범위 |
| 연구 방법론 | 논문·공식 문서·실제 연구 시스템 비교 | 평가 기준, 재현성, 실패 보고, 주장과 구현의 차이 |
| API·Adapter | 프로토콜·계약·호환성 검증 | 버전 협상, capability, unknown field, 오류 모델, wire 호환 테스트 |
| 개발 도구·의존성 | registry metadata + Behavioral Recon | engine·peer 범위, API 유무, 실제 설치·실행, 운영 repo의 조합 |

혼합 Issue는 행을 조합한다. 깊이는 위험에 비례한다 — 공개 계약, 저장 형식, 격리·승인 경계처럼 되돌리기 어려운
결정일수록 소스와 실행까지 본다.

## Discovery 관점

공개 OSS 제품·agent 프로젝트 / 같은 메커니즘을 부품으로 주는 라이브러리·엔진 / 상용 서비스(공식 문서·공개
API) / 표준·명세 / 논문·기술 보고서·postmortem / 인접 도메인(같은 문제 모양을 다른 제품군에서) / Brief가
드러낸 관점.

## 검색 경로

라운드마다 넓힌다: awesome list, GitHub topic, 심볼·오류 메시지 code search, alternatives·비교 글, 찾은 후보의
의존성과 그것을 쓰는 프로젝트, 논문 related work·인용, issue·discussion·PR(실패 패턴), 패키지 레지스트리.

## 심층 대상 선정

질문과의 관련도, 소스·테스트 공개 여부, 운영·유지 상태, 설계 선택의 다양성(다른 해법과 반례를 함께),
라이선스. 소규모·신생 프로젝트는 패턴 참고로만 쓰고 그렇게 표시한다.

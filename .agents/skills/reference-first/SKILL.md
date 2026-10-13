---
name: reference-first
description: 구현 착수 전에 같은 문제를 푼 선행 프로젝트·라이브러리·명세를 조사하고, 소스 읽기와 실행으로 근거를 확인해 채택·배제할 패턴과 권고를 정리한다. GitHub Issue나 기능 주제의 구현을 시작하기 전에 레퍼런스 조사가 필요할 때 쓴다.
argument-hint: "#7 | #24 #26 | <주제>"
disable-model-invocation: true
---

# Reference First

같은 문제를 이미 푼 사례를 찾아 Reference → Evidence → Observation → Pattern → Decision 순서로 좁힌다.
문서·댓글·보고는 한국어로 쓴다.

## 경계

- 조사와 권고만 한다. 제품 코드·테스트·설정은 그대로 두고 구현을 시작하지 않는다. 결과는 어떤 방식으로 구현하든 읽을 수 있는 참고 자료로 쓴다.
- 권고는 확정 계약이 아니다. Issue·`AGENTS.md`·`GLOSSARY.md`·ADR의 결정과 맞지 않는 패턴은 배제하거나
  「상충 — 사용자 판단」으로 남긴다.
- 자격 증명 없이 볼 수 있는 공개 자료와 OSS만 실행한다. 로그인·유료 API·실제 모델 호출이 필요한 확인은
  사용자 승인 전까지 「미확인」이다.

## 산출물

key는 `issue-<n>`(여럿이면 `issue-<n>-<m>`) 또는 kebab-case 주제 이름이다.

- `.reference-cache/<key>/`(git 무시): `candidates.md`, `notes/`, `recon/`, `probes/`, `receipt.md`.
  고정 SHA checkout은 `.reference-cache/src/<owner>-<repo>@<sha7>/`에 두고 재사용한다.
- `docs/research/<key>-references.md`: [assets/references-doc.md](assets/references-doc.md)의 틀. 결정에 쓴
  것만 압축해 담는다. 커밋하지 않고 구현 변경과 함께 커밋되게 둔다.
- Issue receipt 댓글: [assets/receipt.md](assets/receipt.md)의 틀.

## 절차

이 checklist를 복사해 진행 상황을 표시한다.

```
- [ ] 1 Brief
- [ ] 2 Discovery
- [ ] 3 Recon
- [ ] 4 Synthesis
- [ ] 5 Receipt
```

**1 Brief.** `gh issue view <n> --comments`, parent·blocker Issue, `GLOSSARY.md`, `docs/features.md`,
구조 문서, ADR, `docs/research/`·`.reference-cache/`의 기존 조사를 읽고 결과 문서의
Brief를 채운다: 구현할 문제, 동종 문제(제품 이름이 아닌 메커니즘 하나), 고정된 결정, 조사 질문, 재사용할 조사.
질문마다 [references/strategies.md](references/strategies.md)에서 전략을 고른다.
완료: 모든 질문에 출처 항목과 전략이 있고, 찾은 기존 조사마다 재사용 판단이 있다.

**2 Discovery.** Issue의 참고 자료와 기존 조사는 출발점이다. strategies.md의 관점과 검색 경로로 동종 문제의
사례를 찾을 수 있는 만큼 찾고, 모든 후보를 `candidates.md`에 남긴다. 관점이 셋 이상이면 관점별 worker를
병렬로 보낸다: [assets/worker-discovery.md](assets/worker-discovery.md).
완료: 관점마다 saturation 근거(마지막 라운드가 새 패턴·변형·실패 모드를 더하지 않음)가 있고, 질문마다 후보
또는 「레퍼런스 없음」이 있고, 심층 대상마다 선정 이유가 있다.

**3 Recon.** 심층 대상을 [references/recon.md](references/recon.md)대로 조사한다. 대상이 여럿이면
[assets/worker-recon.md](assets/worker-recon.md)로 나눈다. 근거는 [references/evidence.md](references/evidence.md)
규칙으로 기록하고, 결정에 쓸 근거는 메인이 원문을 다시 연다.
완료: 질문마다 결정에 쓸 근거가 수준과 함께 있고, 심층 대상마다 SHA·확인일·미확인 범위가 있다.

**4 Synthesis.** 패턴 표와 결정 표(채택·변형 채택·배제·보류)를 쓴다. `AGENTS.md`의 제품 불변 조건, 폴더
의존 방향, Issue 범위와 대조하고, 다른 Issue의 범위는 「후속 #N」으로 넘긴다. 제품 정책이나 취향이 갈리는
선택은 근거를 붙인 선택지 2–3개로 사용자에게 묻거나 열린 결정으로 남긴다.
완료: 모든 질문이 결정 행에 걸리고, 결정·배제마다 이유가, 열린 결정마다 owner(사용자 또는 Issue)가 있다.

**5 Receipt.** 결과 문서의 「구현 참고」와 「한계와 미확인」을 채우고 receipt를 게시한 뒤 다시 읽어 결정
표와 맞는지 확인한다. Issue 밖 주제는 관련 Issue에 달고, 없으면 결과 문서가 기록이다.

```bash
gh issue comment <n> --body-file .reference-cache/<key>/receipt.md
gh issue view <n> --comments
```

## 보고

| 단계 | 상태 | 근거 |
|---|---|---|
| Brief | 완료·부분·미완료 | 질문 수, 재사용한 조사 |
| Discovery | | 관점별 saturation, 후보 수 |
| Recon | | 심층 대상과 SHA, 수준별 근거 수 |
| Synthesis | | 패턴·결정 수, 사용자 선택 |
| Receipt | | 문서 경로, 댓글 URL |

이어서 접근하지 못한 자료, 미확인 동작, 열린 결정을 적는다.

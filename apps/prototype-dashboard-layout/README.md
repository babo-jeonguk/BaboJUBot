# PROTOTYPE — #50 대시보드 배치 (버려도 되는 코드)

질문: 판 1 대시보드의 공통 셸·조직 탭·Inbox·홈을 **어떤 배치**로 만들까?
세 배치를 같은 mock 자료로 한 route 위에서 `?variant=A|B|C`로 바꿔 본다.

```bash
pnpm install --ignore-scripts
pnpm prototype:layout   # http://127.0.0.1:5180
```

- 하단 막대 ◀ ▶ 또는 키보드 ←/→: 배치 전환. 자료 시나리오: `?data=normal|many|one|empty|loading|error`. 결정 실패 흉내: `?fail=1`.
- 자료는 메모리에만 있다(새로고침하면 초기화). 서버·DB·모델 호출 없음.
- 버튼의 결정·제어는 stub이다. 승인·조직 경계·최종 완료의 강제는 제품 코드(#53–#60)가 맡는다. 여기 disabled 버튼은 그 검증이 아니다.
- 이 폴더는 `prototype/dashboard-layout` 브랜치에만 둔다. main에는 고른 배치의 결정만 옮긴다.

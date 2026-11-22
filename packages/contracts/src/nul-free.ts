// NUL(문자 코드 0)이 없는 문자열. 도구 정의의 pattern으로 그대로 나가므로 같은 뜻의 `\0` 표기를 쓰지 않는다: 일부 모델 서비스가 그 pattern을
// 담은 요청 전체를 거부했다(#147, packages/contracts/src/tools.test.ts). NUL을 일부러 담은 정규식이라 lint의 no-control-regex는
// eslint.config.js가 이 파일에서만 끈다. 이 파일에는 이 정규식 말고 아무것도 두지 않는다.
export const nulFree = /^[^\x00]*$/;

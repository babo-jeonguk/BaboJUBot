// 실제 시험의 "오래 걸리는 작업". 지정한 초만큼 일하다가 끝난다.
const seconds = Number(process.argv[2] ?? 25);
setTimeout(() => {
  console.log("done");
}, seconds * 1000);

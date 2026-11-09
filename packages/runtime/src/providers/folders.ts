import path from "node:path";

/**
 * 프로바이더 연결의 폴더. 연결 폴더는 로그인 원본·준비 확인·모델 목록·프로세스 기록에 쓰고 컨테이너에 넣지 않는다.
 * 실행 시도는 격리 실행 여부와 상관없이 그 조직의 제품 폴더(설정·세션·확장)로 돈다. 같은 연결이라도 한 조직이 써 둔 설정을
 * 다른 조직의 프로그램이 읽지 않게 한다(docs/research/org-product-folders-references.md 사용자 결정).
 */
export function connectionFolders(dataDir: string, connectionId: string) {
  const connection = path.resolve(dataDir, "providers", connectionId);
  return {
    connection,
    organization(organizationId: string) {
      // 조직 ID는 UUID다. 경로를 벗어나는 값은 받지 않는다.
      if (!/^[0-9a-f-]{36}$/i.test(organizationId))
        throw new Error("organization id must be a UUID");
      return path.join(connection, "organizations", organizationId);
    },
  };
}

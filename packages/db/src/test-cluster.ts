import { startTestCluster } from "./testing.ts";

// vitest globalSetup: 테스트 실행 하나에 embedded Postgres 하나를 띄우고, 테스트마다 그 안에 DB를 복제한다.
export default startTestCluster;

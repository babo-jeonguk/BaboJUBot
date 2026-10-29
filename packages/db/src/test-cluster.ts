import { startTestCluster } from "./testing.ts";

// vitest globalSetup: 검사 실행 하나에 embedded Postgres 하나를 띄우고, 검사마다 그 안에 DB를 복제한다.
export default startTestCluster;

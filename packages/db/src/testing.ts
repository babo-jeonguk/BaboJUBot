import { openEphemeralDatabase, type DatabaseHandle } from "./client.ts";

export { freePort } from "./client.ts";

export type TestDatabase = DatabaseHandle;

/** 테스트마다 따로 쓰는 임시 embedded Postgres. */
export const createTestDatabase = openEphemeralDatabase;

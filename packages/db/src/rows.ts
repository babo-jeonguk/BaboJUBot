import type {
  Agent,
  Event,
  NewEvent,
  Organization,
} from "@babojubot/contracts";
import type { Database } from "./client.ts";
import { agents, events, organizations } from "./schema.ts";

/** Database 또는 그 안의 transaction. */
export type Executor =
  Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Event를 저장한다. payload의 에이전트·실행 시도 귀속을 조회용 열로도 남긴다. */
export async function insertEvent(
  db: Executor,
  event: NewEvent
): Promise<Event> {
  const payload = event.payload as { agentId?: string; runId?: string | null };
  const [row] = await db
    .insert(events)
    .values({
      ...event,
      agentId: payload.agentId ?? null,
      runId: payload.runId ?? null,
    })
    .returning();
  return toEvent(row!);
}

export const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** DB 행의 시각을 계약의 ISO 문자열로 바꾼다. */
export const withIsoTime = <T extends { createdAt: Date }>(row: T) => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
export const toOrganization = (
  row: typeof organizations.$inferSelect
): Organization => withIsoTime(row);
export const toAgent = (row: typeof agents.$inferSelect): Agent =>
  withIsoTime(row);
export const toEvent = ({
  agentId: _agentId,
  runId: _runId,
  ...row
}: typeof events.$inferSelect): Event => withIsoTime(row) as Event;

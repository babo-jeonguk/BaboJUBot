-- 조직 안에서 대소문자만 다른 이름도 겹친다. 예전 판은 작업자를 만들 때 Lead의 바뀐 이름을 보지 않아 겹친 이름이 남았을 수 있다.
-- 겹친 이름마다 가장 먼저 들어온 에이전트(같은 시각이면 ID 순)만 그대로 두고, 나머지는 " 2", " 3"…을 붙여
-- 조직의 어느 이름과도 겹치지 않는 첫 이름으로 바꾼 뒤 index를 만든다.
DO $$
DECLARE
  duplicate record;
  n integer;
  candidate text;
BEGIN
  FOR duplicate IN
    SELECT id, organization_id, name
    FROM (
      SELECT id, organization_id, name, created_at,
        row_number() OVER (
          PARTITION BY organization_id, lower(name) ORDER BY created_at, id
        ) AS position
      FROM agents
    ) ranked
    WHERE position > 1
    ORDER BY organization_id, created_at, id
  LOOP
    n := 2;
    LOOP
      candidate := duplicate.name || ' ' || n;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM agents
        WHERE organization_id = duplicate.organization_id
          AND lower(name) = lower(candidate)
      );
      n := n + 1;
    END LOOP;
    UPDATE agents SET name = candidate WHERE id = duplicate.id;
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_organization_name_unique" ON "agents" USING btree ("organization_id",lower("name"));

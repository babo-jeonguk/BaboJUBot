import { expect, test } from "@playwright/test";
import { goalInput } from "./support/organization.ts";

// 조직 › 설정의 외부 연결 허용 목록(#149). 사용자가 이름·포트를 추가하고 지우면 바로 저장되고, 잘못 적은 이름은 저장하지 않는다.
test("the owner adds and removes an allowed destination in settings, and a vague name is not saved", async ({
  page,
}) => {
  const created = await page.request.post("/api/organizations", {
    data: { name: "허용 목록 E2E 조직", ...goalInput },
  });
  const org = (await created.json()) as { id: string };
  const saved = async () =>
    (
      (await (
        await page.request.get(`/api/organizations/${org.id}/network-policy`)
      ).json()) as { destinations: { host: string; port: number }[] }
    ).destinations;

  await page.goto(`/orgs/${org.id}/settings`);
  const section = page.getByRole("region", { name: "외부 연결 허용 목록" });
  await expect(section.getByText("허용한 곳이 없습니다")).toBeVisible();

  await section.getByLabel("이름").fill("*.com");
  await section.getByRole("button", { name: "추가" }).click();
  await expect(section.getByRole("alert")).toContainText(
    "이름·포트·주소를 확인해 주세요"
  );
  expect(await saved()).toEqual([]);

  await section.getByLabel("이름").fill("API.Example.com");
  await section.getByLabel("포트").fill("443");
  await section.getByRole("button", { name: "추가" }).click();
  await expect(section.getByText("api.example.com:443")).toBeVisible();
  await expect(section.getByLabel("이름")).toHaveValue("");
  expect(await saved()).toEqual([{ host: "api.example.com", port: 443 }]);

  await section.getByLabel("이름").fill("models.lan");
  await section.getByLabel("포트").fill("8000");
  await section.getByLabel("허용할 내부 주소(선택)").fill("10.0.0.5");
  await section.getByRole("button", { name: "추가" }).click();
  await expect(section.getByText("내부 주소 허용: 10.0.0.5")).toBeVisible();

  await section
    .getByRole("button", { name: "api.example.com:443 삭제" })
    .click();
  await expect(section.getByText("api.example.com:443")).toHaveCount(0);
  expect(await saved()).toEqual([
    { host: "models.lan", port: 8000, addresses: ["10.0.0.5"] },
  ]);

  // 바뀐 기록이 조직 활동에 남는다.
  const events = (await (
    await page.request.get(`/api/organizations/${org.id}/events`)
  ).json()) as { type: string }[];
  expect(
    events.filter((e) => e.type === "organization.network_policy_changed")
  ).toHaveLength(3);
});

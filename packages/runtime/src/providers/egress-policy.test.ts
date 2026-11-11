import { describe, expect, it } from "vitest";
import { destinationSchema, type Destination } from "@babojubot/contracts";
import { decideDestination, type EgressRules } from "./egress-policy.ts";

// 격리 실행의 외부 통신 판정(#149). 이름·포트가 허용 목록에 있고, 실제로 연결할 주소가 모두 금지 주소가 아닐 때만 연다.

const destination = (value: unknown): Destination =>
  destinationSchema.parse(value);
const rules = (
  destinations: unknown[],
  extra: Partial<EgressRules> = {}
): EgressRules => ({
  destinations: destinations.map(destination),
  protectedPorts: [3100, 54329],
  hostAddresses: ["203.0.113.7"],
  ...extra,
});
const resolver =
  (answers: Record<string, string[]>) =>
  async (host: string): Promise<string[]> => {
    const found = answers[host];
    if (!found) throw new Error("not found");
    return found;
  };

describe("egress destination decision", () => {
  it("opens an allowed name and port and connects to the address it checked", async () => {
    const decision = await decideDestination(
      rules([{ host: "api.example.com", port: 443 }]),
      "API.Example.com.",
      443,
      resolver({ "api.example.com": ["93.184.216.34"] })
    );
    expect(decision).toEqual({ allowed: true, addresses: ["93.184.216.34"] });
  });

  it("refuses a name or port that is not on the list, and an empty list", async () => {
    const resolve = resolver({ "api.example.com": ["93.184.216.34"] });
    const allowed = rules([{ host: "api.example.com", port: 443 }]);
    for (const [policy, host, port] of [
      [allowed, "api.example.com", 80],
      [allowed, "other.example.com", 443],
      [allowed, "example.com", 443],
      [rules([]), "api.example.com", 443],
    ] as const)
      expect(await decideDestination(policy, host, port, resolve)).toEqual({
        allowed: false,
        reason: "destination_not_allowed",
      });
  });

  it("matches a wildcard against sub-names only", async () => {
    const policy = rules([{ host: "*.example.com", port: 443 }]);
    const resolve = resolver({
      "a.example.com": ["93.184.216.34"],
      "a.b.example.com": ["93.184.216.34"],
      "example.com": ["93.184.216.34"],
      "badexample.com": ["93.184.216.34"],
    });
    const allowed = async (host: string) =>
      (await decideDestination(policy, host, 443, resolve)).allowed;
    expect(await allowed("a.example.com")).toBe(true);
    expect(await allowed("a.b.example.com")).toBe(true);
    expect(await allowed("example.com")).toBe(false);
    expect(await allowed("badexample.com")).toBe(false);
  });

  it("refuses an allowed name that resolves to this computer, the LAN, metadata or other reserved addresses", async () => {
    const policy = rules([{ host: "api.example.com", port: 443 }]);
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.10",
      "100.64.0.1",
      "169.254.169.254",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "203.0.113.7", // 이 컴퓨터의 공인 주소
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "fd00:ec2::254",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2002:a00:1::",
    ])
      expect(
        await decideDestination(
          policy,
          "api.example.com",
          443,
          resolver({ "api.example.com": [address] })
        ),
        address
      ).toEqual({ allowed: false, reason: "address_not_allowed" });
  });

  it("refuses the whole name when any of its addresses is forbidden (mixed A/AAAA)", async () => {
    expect(
      await decideDestination(
        rules([{ host: "api.example.com", port: 443 }]),
        "api.example.com",
        443,
        resolver({ "api.example.com": ["93.184.216.34", "::1"] })
      )
    ).toEqual({ allowed: false, reason: "address_not_allowed" });
  });

  it("opens a literal IP only when that exact IP is listed, without resolving it", async () => {
    const noResolve = async () => {
      throw new Error("must not resolve a literal address");
    };
    expect(
      await decideDestination(
        rules([{ host: "93.184.216.34", port: 443 }]),
        "93.184.216.34",
        443,
        noResolve
      )
    ).toEqual({ allowed: true, addresses: ["93.184.216.34"] });
    expect(
      await decideDestination(
        rules([{ host: "api.example.com", port: 443 }]),
        "93.184.216.34",
        443,
        noResolve
      )
    ).toEqual({ allowed: false, reason: "destination_not_allowed" });
    // 대괄호 IPv6와 IPv4를 담은 IPv6 표기도 같은 주소로 본다.
    expect(
      await decideDestination(
        rules([{ host: "2606:2800:220:1::1", port: 443 }]),
        "[2606:2800:0220:0001:0:0:0:1]",
        443,
        noResolve
      )
    ).toEqual({ allowed: true, addresses: ["2606:2800:220:1:0:0:0:1"] });
  });

  it("opens a user-listed internal endpoint only at its listed addresses, never the user API or DB port", async () => {
    const policy = rules([
      { host: "models.lan", port: 8000, addresses: ["10.0.0.5"] },
      { host: "localhost", port: 11434, addresses: ["127.0.0.1"] },
      { host: "sneaky.lan", port: 3100, addresses: ["127.0.0.0/8"] },
    ]);
    const resolve = resolver({
      "models.lan": ["10.0.0.5"],
      localhost: ["127.0.0.1"],
      "sneaky.lan": ["127.0.0.1"],
    });
    expect(
      await decideDestination(policy, "models.lan", 8000, resolve)
    ).toEqual({ allowed: true, addresses: ["10.0.0.5"] });
    expect(
      await decideDestination(policy, "localhost", 11434, resolve)
    ).toEqual({ allowed: true, addresses: ["127.0.0.1"] });
    // 같은 이름이 다른 내부 주소로 바뀌면 거부한다.
    expect(
      await decideDestination(
        policy,
        "models.lan",
        8000,
        resolver({ "models.lan": ["10.0.0.6"] })
      )
    ).toEqual({ allowed: false, reason: "address_not_allowed" });
    expect(
      await decideDestination(policy, "sneaky.lan", 3100, resolve)
    ).toEqual({ allowed: false, reason: "address_not_allowed" });
  });

  it("reports a name it cannot resolve", async () => {
    expect(
      await decideDestination(
        rules([{ host: "api.example.com", port: 443 }]),
        "api.example.com",
        443,
        resolver({})
      )
    ).toEqual({ allowed: false, reason: "not_resolved" });
  });

  it("rejects ambiguous names in the policy itself", () => {
    for (const host of ["*.com", "a.*.com", "010.0.0.1", "0x7f.1", "1.2.3", ""])
      expect(
        destinationSchema.safeParse({ host, port: 443 }).success,
        host
      ).toBe(false);
    expect(
      destinationSchema.safeParse({
        host: "a.com",
        port: 443,
        addresses: ["10.0.0.0/33"],
      }).success
    ).toBe(false);
  });
});

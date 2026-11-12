import {
  cidrContains,
  formatIp,
  normalizeHost,
  parseCidr,
  parseIp,
  type Destination,
  type EgressRefusal,
  type IpAddress,
} from "@babojubot/contracts";

/** 실행 시도 하나의 외부 통신 판정 재료. */
export type EgressRules = {
  /** 지금 열 수 있는 목적지(필수 모델·로그인 목적지와, 연구 단계면 조직의 허용 목록). */
  destinations: readonly Destination[];
  /** 이 컴퓨터에서 어떤 예외로도 열지 않는 포트(사용자 API·DB). */
  protectedPorts: readonly number[];
  /** 이 컴퓨터의 주소. 0.0.0.0에 열린 서비스는 이 주소로도 닿으므로 loopback처럼 막는다. */
  hostAddresses: readonly string[];
};

export type EgressDecision =
  | { allowed: true; addresses: string[] }
  | { allowed: false; reason: EgressRefusal };

const ranges = (values: string[]) =>
  values.map((value) => {
    const parsed = parseCidr(value);
    if (!parsed) throw new Error(`invalid built-in range ${value}`);
    return parsed;
  });

/** 이 컴퓨터 자신(loopback·미지정). 사용자 API·DB 포트는 여기서 어떤 예외로도 열지 않는다. */
const selfRangeTexts = ["127.0.0.0/8", "0.0.0.0/8", "::1/128", "::/128"];
const selfRanges = ranges(selfRangeTexts);

/**
 * 기본으로 막는 주소. 허용한 이름이 이 주소로 풀리면 거부하고, 사용자가 그 목적지에 적은 주소일 때만 연다.
 * sandbox-runtime(resolved-address-guard.ts)·Codex(network-proxy connect_policy.rs)와 달리 사설망·CGNAT·ULA도 기본으로 막는다(#149 결정).
 */
const forbiddenRanges = ranges([
  ...selfRangeTexts,
  // 사설망·공유 주소(CGNAT)·IETF·벤치마크·문서용·예약
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "240.0.0.0/4",
  // link-local(대부분의 클라우드 metadata 포함)·멀티캐스트·broadcast
  "169.254.0.0/16",
  "224.0.0.0/4",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
  // ULA(IPv6 metadata fd00:ec2::254 등 포함)·문서용·Teredo
  "fc00::/7",
  "2001:db8::/32",
  "2001::/32",
]);

/** IPv6 안에 IPv4를 담은 표기(mapped·compatible·NAT64·6to4)의 IPv4. 그 IPv4에도 같은 규칙을 쓴다. */
function embeddedIpv4(address: IpAddress): IpAddress | undefined {
  if (address.family !== 6) return undefined;
  const b = address.bytes;
  const zero = (from: number, to: number) =>
    b.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d, ::a.b.c.d
  if (zero(0, 10) && ((b[10] === 0xff && b[11] === 0xff) || zero(10, 12)))
    return zero(0, 16) || (zero(0, 15) && b[15] === 1)
      ? undefined
      : { family: 4, bytes: b.slice(12, 16) };
  // 64:ff9b::/96
  if (
    b[0] === 0 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    zero(4, 12)
  )
    return { family: 4, bytes: b.slice(12, 16) };
  // 2002:aabb:ccdd::/48
  if (b[0] === 0x20 && b[1] === 0x02)
    return { family: 4, bytes: b.slice(2, 6) };
  return undefined;
}

const sameAddress = (a: IpAddress, b: IpAddress) =>
  a.family === b.family && a.bytes.every((x, i) => x === b.bytes[i]);

/** 이름·포트가 목록에 있는 항목. 이름이 정규화되지 않거나 와일드카드이거나 포트가 범위 밖이면 빈 목록. */
function listedEntries(
  destinations: readonly Destination[],
  requestedHost: string,
  port: number
): Destination[] {
  const host = normalizeHost(requestedHost);
  if (
    !host ||
    host.startsWith("*.") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return [];
  return destinations.filter((entry) => matches(entry, host, port));
}

function matches(entry: Destination, host: string, port: number) {
  if (entry.port !== port) return false;
  if (entry.host.startsWith("*."))
    return (
      host.endsWith(entry.host.slice(1)) && host.length > entry.host.length - 1
    );
  return entry.host === host;
}

/**
 * 주소 하나가 이 목록 항목들에서 열리는지. 이 컴퓨터·protected 포트·금지 주소는 목적지에 적은 주소 하나와 같을 때만 연다.
 * 예외는 주소 하나이며 대역이 아니다.
 */
function addressAllowed(
  rules: EgressRules,
  entries: readonly Destination[],
  address: IpAddress,
  port: number
): boolean {
  const own = rules.hostAddresses
    .map((text) => parseIp(text))
    .filter((value): value is IpAddress => value !== null);
  const exceptions = entries.flatMap((entry) =>
    (entry.addresses ?? []).flatMap((text) => {
      const parsed = parseIp(text);
      return parsed ? [parsed] : [];
    })
  );
  const forms = [address, embeddedIpv4(address)].filter(
    (form): form is IpAddress => form !== undefined
  );
  const self = forms.some(
    (form) =>
      selfRanges.some((range) => cidrContains(range, form)) ||
      own.some((value) => sameAddress(value, form))
  );
  if (self && rules.protectedPorts.includes(port)) return false;
  const forbidden =
    self ||
    forms.some((form) =>
      forbiddenRanges.some((range) => cidrContains(range, form))
    );
  if (
    forbidden &&
    !exceptions.some((exception) =>
      forms.some((form) => sameAddress(exception, form))
    )
  )
    return false;
  return true;
}

/**
 * 목적지 하나를 판정한다. 이름·포트가 목록에 있어야 하고, 이름이면 이 컴퓨터에서 주소로 풀어 모든 주소를 본다.
 * 하나라도 금지 주소면(그 목적지의 예외 밖) 이름 전체를 거부한다. 연결은 돌려준 주소로만 하며 다시 풀지 않는다.
 * IP를 직접 적은 연결은 그 IP를 목록에 적었을 때만 열며, 금지 주소 규칙은 똑같이 적용한다.
 */
export async function decideDestination(
  rules: EgressRules,
  requestedHost: string,
  port: number,
  resolve: (host: string) => Promise<string[]>
): Promise<EgressDecision> {
  const host = normalizeHost(requestedHost);
  if (
    !host ||
    host.startsWith("*.") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return { allowed: false, reason: "destination_not_allowed" };
  const entries = listedEntries(rules.destinations, requestedHost, port);
  if (entries.length === 0)
    return { allowed: false, reason: "destination_not_allowed" };
  const literal = parseIp(host);
  let texts: string[];
  if (literal) texts = [host];
  else {
    try {
      texts = await resolve(host);
    } catch {
      return { allowed: false, reason: "not_resolved" };
    }
  }
  const addresses = texts.map((text) => parseIp(text));
  if (addresses.length === 0 || addresses.some((address) => !address))
    return { allowed: false, reason: "not_resolved" };
  for (const address of addresses as IpAddress[]) {
    if (!addressAllowed(rules, entries, address, port))
      return { allowed: false, reason: "address_not_allowed" };
  }
  return {
    allowed: true,
    addresses: (addresses as IpAddress[]).map((address) => formatIp(address)),
  };
}

/** 이미 연결한 주소 하나가 지금 규칙에서도 열리는지. 이름을 다시 풀지 않는다. 새 연결 판정과 같은 규칙이다. */
export function allowsConnection(
  rules: EgressRules,
  requestedHost: string,
  port: number,
  address: string
): boolean {
  const entries = listedEntries(rules.destinations, requestedHost, port);
  if (entries.length === 0) return false;
  const parsed = parseIp(address);
  if (!parsed) return false;
  return addressAllowed(rules, entries, parsed, port);
}

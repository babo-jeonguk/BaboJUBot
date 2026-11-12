import { z } from "zod";

/**
 * 격리 실행의 외부 통신 목적지(#149). 컨테이너에는 네트워크가 없고, 실행 시도 밖의 중계가 이 목록에 있는 이름·포트만 연다.
 * - `host`: 이름(`example.com`), 하위 이름 전체(`*.example.com`, `example.com` 자체는 포함하지 않음), 또는 IP 주소.
 * - `port`: 그 이름의 포트 하나.
 * - `addresses`: 이 목적지가 내부 주소(이 컴퓨터·사설망 등)로 이어져도 되는 주소. 적은 주소만 예외이며 대역은
 *   받지 않는다. 없으면 내부 주소로 풀리는 이름은 거부한다. 사용자 API·DB 포트는 이 예외로도 열리지 않는다.
 */
export const destinationSchema = z.strictObject({
  host: z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => normalizeHost(value) !== null, {
      message: "이름(example.com, *.example.com) 또는 IP 주소를 적는다",
    })
    .transform((value) => normalizeHost(value)!),
  port: z.number().int().min(1).max(65535),
  addresses: z
    .array(
      z
        .string()
        .trim()
        .refine((value) => parseIp(value) !== null, {
          message: "IP 주소를 하나씩 적는다(대역은 받지 않는다)",
        })
    )
    .max(16)
    .optional(),
});
export type Destination = z.infer<typeof destinationSchema>;

/** 조직의 외부 통신 허용 목록. 사용자만 바꾸며 조직 도구가 없다. 새 조직은 비어 있어 연구 목적지는 모두 거부된다. */
export const networkPolicySchema = z.strictObject({
  destinations: z.array(destinationSchema).max(200),
});
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;
export const defaultNetworkPolicy: NetworkPolicy = { destinations: [] };

/** 허용 목록 변경 제어 명령. 목록 전체를 바꾼다. */
export const updateNetworkPolicyInputSchema = networkPolicySchema;
export type UpdateNetworkPolicyInput = z.infer<
  typeof updateNetworkPolicyInputSchema
>;

/**
 * 중계가 연결을 거부한 이유.
 * - `destination_not_allowed`: 이름·포트가 허용 목록에 없다.
 * - `address_not_allowed`: 허용한 이름이지만 이 컴퓨터·내부망·metadata 같은 금지 주소로 풀렸다.
 * - `not_resolved`: 이름을 주소로 풀지 못했다.
 * - `protocol_not_supported`: HTTP 프록시(CONNECT·절대 주소 요청) 밖의 요청이다.
 * - `policy_unavailable`: 정책을 읽지 못했다. 열지 않는다.
 * - `policy_changed`: 사용자가 목록을 줄여 이미 열린 연결을 닫았다.
 */
export const egressRefusals = [
  "destination_not_allowed",
  "address_not_allowed",
  "not_resolved",
  "protocol_not_supported",
  "policy_unavailable",
  "policy_changed",
] as const;
export type EgressRefusal = (typeof egressRefusals)[number];

/** 거부 이유의 사용자 안내. 실행 활동에 남는다. */
export const egressRefusalMessages: Record<EgressRefusal, string> = {
  destination_not_allowed:
    "조직의 네트워크 허용 목록에 없는 목적지라 연결하지 않았습니다. 조직 설정의 네트워크 허용 목록에 이름과 포트를 추가한 뒤 다시 시도할 수 있습니다.",
  address_not_allowed:
    "허용한 이름이지만 이 컴퓨터나 내부망 주소로 이어져 연결하지 않았습니다. 꼭 필요하면 조직 설정에서 그 목적지에 허용할 내부 주소를 적은 뒤 다시 시도할 수 있습니다.",
  not_resolved: "목적지 이름을 주소로 풀지 못해 연결하지 않았습니다.",
  protocol_not_supported:
    "격리 실행은 HTTP 프록시를 거친 연결만 엽니다. 다른 방식의 연결은 하지 않았습니다.",
  policy_unavailable:
    "네트워크 정책을 확인하지 못해 연결하지 않았습니다. 잠시 뒤 다시 시도해 주세요.",
  policy_changed:
    "조직의 네트워크 허용 목록이 바뀌어 더 이상 허용되지 않는 연결을 닫았습니다.",
};

/** IP 주소 하나. IPv4는 4바이트, IPv6는 16바이트. */
export type IpAddress = { family: 4 | 6; bytes: number[] };

/** IP 주소 글자를 읽는다. 아니면 `null`. IPv6의 zone(`%eth0`)·대괄호는 받지 않는다. */
export function parseIp(text: string): IpAddress | null {
  const v4 = parseIpv4(text);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseIpv6(text);
  return v6 ? { family: 6, bytes: v6 } : null;
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    // 앞의 0(010)·16진수는 해석이 엇갈리므로 받지 않는다.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseIpv6(text: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const words: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (i === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        words.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      words.push(parseInt(piece, 16));
    }
    return words;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  // 끝의 IPv4는 앞 쪽(head)에만 올 수 없다.
  if (halves.length === 2 && halves[0]!.includes(".")) return null;
  let words: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    words = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    words = head;
  }
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

/** IP 대역(`10.0.0.0/8`) 또는 주소 하나(대역 길이 최대). 아니면 `null`. */
export function parseCidr(
  text: string
): { address: IpAddress; prefix: number } | null {
  const [base, length, ...rest] = text.split("/");
  if (rest.length > 0 || base === undefined) return null;
  const address = parseIp(base);
  if (!address) return null;
  const max = address.family === 4 ? 32 : 128;
  if (length === undefined) return { address, prefix: max };
  if (!/^(0|[1-9][0-9]{0,2})$/.test(length)) return null;
  const prefix = Number(length);
  if (prefix > max) return null;
  return { address, prefix };
}

/** 주소가 대역 안인지. 주소 체계가 다르면 아니다. */
export function cidrContains(
  cidr: { address: IpAddress; prefix: number },
  address: IpAddress
): boolean {
  if (cidr.address.family !== address.family) return false;
  let bits = cidr.prefix;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((cidr.address.bytes[i]! & mask) !== (address.bytes[i]! & mask))
      return false;
  }
  return true;
}

/** 주소의 정규 글자. IPv6는 소문자·0 줄임 없이 쓴다(같은 주소면 같은 글자). */
export function formatIp(address: IpAddress): string {
  if (address.family === 4) return address.bytes.join(".");
  const words: string[] = [];
  for (let i = 0; i < 16; i += 2)
    words.push(((address.bytes[i]! << 8) | address.bytes[i + 1]!).toString(16));
  return words.join(":");
}

/**
 * 목적지 이름의 정규 형태. 소문자, 끝의 점 없음, IPv6 대괄호 없음. IP는 정규 글자로 바꾼다. 받지 않는 이름이면 `null`.
 * `*.`은 맨 앞에만 오며 그 뒤에 이름이 둘 이상이어야 한다(`*.com` 거부).
 */
export function normalizeHost(text: string): string | null {
  let value = text.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const ip = parseIp(value);
  if (ip) return formatIp(ip);
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (value.length === 0 || value.length > 253) return null;
  const wildcard = value.startsWith("*.");
  const name = wildcard ? value.slice(2) : value;
  const labels = name.split(".");
  if (wildcard && labels.length < 2) return null;
  for (const label of labels)
    if (!/^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label)) return null;
  // 숫자만 있는 마지막 이름은 IP 표기 변형(10.1, 0x7f.1)과 헷갈리므로 받지 않는다.
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null;
  return value;
}

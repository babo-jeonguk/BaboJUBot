import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeMessage, MessageReader, nextPhase } from "./supervised.ts";

// 제어 통로의 틀과 순서(#274 외부 리뷰 2회차 SPEC-3·SPEC-4). 실행기의 Rust 시험과 같은 자료(`supervisor/protocol-*.txt`)를 읽어,
// 두 쪽이 같은 인코딩과 같은 전이 표를 지키는지 본다.
const rows = (file: string) =>
  readFileSync(new URL(`../supervisor/${file}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => line.trim().split(/\s+/));
const bytes = (hex: string) => Buffer.from(hex === "-" ? "" : hex, "hex");

describe("control channel framing", () => {
  const vectors = rows("protocol-vectors.txt");

  for (const [, message, encoded] of vectors.filter(
    ([kind]) => kind === "ok"
  )) {
    const text = bytes(message!).toString("utf8");
    it(`frames ${JSON.stringify(text)} and reads it back, whole or a byte at a time`, () => {
      expect(encodeMessage(text)).toEqual(bytes(encoded!));
      expect(new MessageReader().push(bytes(encoded!))).toEqual([text]);
      const reader = new MessageReader();
      const read: string[] = [];
      for (const byte of bytes(encoded!))
        read.push(...reader.push(Buffer.from([byte])));
      expect(read).toEqual([text]);
    });
  }

  for (const [, encoded] of vectors.filter(([kind]) => kind === "bad"))
    it(`refuses ${JSON.stringify(bytes(encoded!).toString("latin1"))}`, () => {
      expect(() => new MessageReader().push(bytes(encoded!))).toThrow(
        /malformed control message/
      );
    });

  it("reads several messages that arrive together", () => {
    const together = Buffer.concat([
      encodeMessage("env A=a\nstart"),
      encodeMessage("start"),
    ]);
    expect(new MessageReader().push(together)).toEqual([
      "env A=a\nstart",
      "start",
    ]);
  });
});

describe("control channel order", () => {
  const table = rows("protocol-transitions.txt");

  for (const [, phase, event, next] of table.filter(
    ([kind]) => kind === "transition"
  ))
    it(`goes from ${phase} to ${next} on ${event}`, () => {
      expect(nextPhase(phase!, event!)).toBe(next);
    });

  const run = (events: string[]) =>
    events.reduce<string | undefined>(
      (phase, event) =>
        phase === undefined ? undefined : nextPhase(phase, event),
      "hello"
    );
  for (const [kind, ...events] of table.filter(
    ([kind]) => kind === "accept" || kind === "reject"
  ))
    it(`${kind}s ${events.join(" → ")}`, () => {
      if (kind === "accept") expect(run(events)).toBeDefined();
      else expect(run(events)).toBeUndefined();
    });
});

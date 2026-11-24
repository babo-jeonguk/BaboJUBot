import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodeMessage,
  MessageReader,
  nextPhase,
  readSupervisorLine,
  supervisorProtocol,
} from "./supervised.ts";

// 제어 통로의 틀과 순서(#274 외부 리뷰 2회차 SPEC-3·SPEC-4). 실행기의 Rust 시험과 같은 자료(`supervisor/protocol-*.txt`)를 읽어,
// 두 쪽이 같은 인코딩과 같은 전이 표를 지키는지 본다.
const parse = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => line.trim().split(/\s+/));
const rows = (file: string) =>
  parse(
    readFileSync(new URL(`../supervisor/${file}`, import.meta.url), "utf8")
  );
const bytes = (hex: string) => Buffer.from(hex === "-" ? "" : hex, "hex");

/** 공용 자료의 줄 종류와 그 줄이 받는 칸 수(종류 이름 뒤). Rust 시험도 같은 모양을 확인한다. */
type Shape = Record<string, (fields: number) => boolean>;
const vectorShape: Shape = {
  ok: (fields) => fields === 2,
  bad: (fields) => fields === 1,
  hello: (fields) => fields === 2,
  "old-hello": (fields) => fields === 1,
};
const transitionShape: Shape = {
  transition: (fields) => fields === 3,
  accept: (fields) => fields >= 1,
  reject: (fields) => fields >= 1,
};
/**
 * 자료가 모양을 벗어난 곳(#286): 모르는 종류이거나 칸 수가 맞지 않는 줄, 사례가 하나도 없는 종류. 아래 시험들은 종류별로 줄을 골라
 * 만들어지므로, 한 종류를 지우거나 이름을 틀리면 그 사례의 시험이 실패 없이 사라진다. 그래서 둘 다 비었는지를 따로 본다.
 */
const offShape = (rows: string[][], shape: Shape) => ({
  rows: rows
    .filter(
      ([kind, ...fields]) =>
        kind === undefined ||
        !Object.hasOwn(shape, kind) ||
        !shape[kind]!(fields.length)
    )
    .map((row) => row.join(" ")),
  emptyKinds: Object.keys(shape).filter(
    (kind) => !rows.some(([each]) => each === kind)
  ),
});

// 위 모양 확인이 빠진 종류와 모양 밖의 줄을 실제로 짚는지 본다(Rust 시험도 같은 사례를 본다).
it("finds a kind with no rows and rows of an unknown kind or shape", () => {
  expect(
    offShape(parse("ok - 303a2c\nhello - 00\nold-hello 00"), vectorShape)
  ).toEqual({ rows: [], emptyKinds: ["bad"] });
  expect(
    offShape(
      parse("ok - 303a2c\nbad 00\nbda 00\nhello 00\nold-hello 00"),
      vectorShape
    )
  ).toEqual({ rows: ["bda 00", "hello 00"], emptyKinds: [] });
  expect(
    offShape(
      parse("transition hello hello\naccept hello\nreject"),
      transitionShape
    )
  ).toEqual({ rows: ["transition hello hello", "reject"], emptyKinds: [] });
});

describe("control channel framing", () => {
  const vectors = rows("protocol-vectors.txt");

  it("has cases of every kind, and only rows of a known kind and shape", () => {
    expect(offShape(vectors, vectorShape)).toEqual({
      rows: [],
      emptyKinds: [],
    });
  });

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

  // 실행기의 첫 메시지(#283 외부 리뷰 4회차 SPEC-4): 실행기의 Rust 시험과 같은 줄을 읽는다. 시작 시각 칸은 반드시 있다(값 또는 -).
  for (const [, start, line] of vectors.filter(([kind]) => kind === "hello")) {
    const text = bytes(line!).toString("utf8");
    it(`reads the first message ${JSON.stringify(text)}`, () => {
      expect(readSupervisorLine(text)).toEqual({
        kind: "hello",
        protocol: supervisorProtocol,
        ...(start !== "-" && { start }),
      });
    });
  }
  for (const [, line] of vectors.filter(([kind]) => kind === "old-hello")) {
    const text = bytes(line!).toString("utf8");
    it(`reads ${JSON.stringify(text)} as a first message without its start`, () => {
      expect(readSupervisorLine(text)).toEqual({
        kind: "hello",
        protocol: supervisorProtocol,
        withoutStart: true,
      });
    });
  }

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

  it("has rows of every kind, and only rows of a known kind and shape", () => {
    expect(offShape(table, transitionShape)).toEqual({
      rows: [],
      emptyKinds: [],
    });
  });

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

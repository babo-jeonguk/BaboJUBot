// 바깥 JSON의 필드 읽기(json-field.ts). 객체에서만, 그 필드가 실제로 가진 타입으로만 읽는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { field, listField, numberField, textField } from "./json-field.ts";

test("reads a field only from an object that has it", () => {
  const value: unknown = JSON.parse('{"a":1,"b":null}');
  assert.equal(field(value, "a"), 1);
  assert.equal(field(value, "b"), null);
  assert.equal(field(value, "missing"), undefined);
  for (const other of [null, undefined, "text", 3, [1, 2]])
    assert.equal(field(other, "length"), undefined, JSON.stringify(other));
});

test("does not read what every object inherits", () => {
  const value: unknown = JSON.parse("{}");
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"])
    assert.equal(field(value, name), undefined, name);
  assert.equal(
    field(JSON.parse('{"__proto__":{"a":1}}'), "__proto__") !== undefined,
    true
  );
});

test("reads text, numbers and lists only as what they are", () => {
  const value: unknown = JSON.parse(
    '{"text":"a","number":2,"list":[1],"wrong":"2"}'
  );
  assert.equal(textField(value, "text"), "a");
  assert.equal(textField(value, "number"), undefined);
  assert.equal(numberField(value, "number"), 2);
  assert.equal(numberField(value, "wrong"), undefined);
  assert.deepEqual(listField(value, "list"), [1]);
  assert.equal(listField(value, "text"), undefined);
});

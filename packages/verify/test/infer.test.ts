import { expect, test } from "bun:test";
import { inferSchema } from "../src/registry/infer";

test("infers required fields, unions and nested arrays from samples", () => {
  const samples = [
    { type: "invoice.paid", amount: 4200, paidAt: "2026-10-19T03:00:00Z", lines: [{ sku: "a", qty: 1 }], note: null },
    { type: "invoice.paid", amount: 99.5, paidAt: "2026-10-19T03:00:01.120+02:00", lines: [], note: "hi", coupon: "X" },
  ];
  expect(inferSchema(samples)).toEqual({
    type: "object",
    properties: {
      type: { type: "string" },
      amount: { type: "number" },
      paidAt: { type: "string", format: "date-time" },
      lines: {
        type: "array",
        items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "integer" } }, required: ["sku", "qty"] },
      },
      note: { type: ["null", "string"] },
      coupon: { type: "string" },
    },
    required: ["type", "amount", "paidAt", "lines", "note"],
    examples: samples,
  });
});

test("mixed objects and primitives become anyOf, and __proto__ is just a key", () => {
  const samples = [JSON.parse('{"__proto__": 1, "v": {"a": 1}}'), { v: "x" }];
  const schema = inferSchema(samples);
  expect(JSON.stringify(schema)).toStartWith('{"type":"object","properties":{"__proto__":{"type":"integer"},"v":');
  expect(schema).toMatchObject({
    properties: {
      v: { anyOf: [{ type: "object", properties: { a: { type: "integer" } }, required: ["a"] }, { type: "string" }] },
    },
    required: ["v"],
  });
});

test("keeps at most three examples", () => {
  expect(inferSchema([1, 2, 3, 4]).examples).toEqual([1, 2, 3]);
});

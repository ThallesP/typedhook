import { describe, expect, test } from "bun:test";
import { canonicalJson, hashDocument } from "../src/registry/hash";

describe("canonicalJson", () => {
  test("sorts integer-like keys as strings, unlike JSON.stringify", () => {
    const value = { a: 1, "10": 2, "2": 3 };
    expect(JSON.stringify(value)).toBe('{"2":3,"10":2,"a":1}');
    expect(canonicalJson(value)).toBe('{"10":2,"2":3,"a":1}');
  });

  test("sorts at every depth, keeps array order and adds no whitespace", () => {
    const value = { b: [{ z: true, y: null }, 2], a: { d: "x", c: 1.5 } };
    expect(canonicalJson(value)).toBe('{"a":{"c":1.5,"d":"x"},"b":[{"y":null,"z":true},2]}');
  });

  test("treats undefined like JSON.stringify does", () => {
    const value = { a: undefined, b: [undefined, 1] };
    expect(canonicalJson(value)).toBe(JSON.stringify(value));
  });
});

describe("hashDocument", () => {
  test("is sha256- plus padded base64 of the canonical JSON", async () => {
    // printf '{"10":2,"2":3,"a":1}' | openssl dgst -sha256 -binary | base64
    expect(await hashDocument({ a: 1, "2": 3, "10": 2 })).toBe("sha256-pleCuxCOj2ftCJv+83PLtyKLHuTlQvtwy52zwuSdLlI=");
  });

  test("ignores key order", async () => {
    expect(await hashDocument({ b: 1, a: 2 })).toBe(await hashDocument({ a: 2, b: 1 }));
  });
});

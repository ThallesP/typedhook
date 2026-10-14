import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { jsonSchemaToTs } from "../src/registry/json-schema-to-ts";

describe("jsonSchemaToTs", () => {
  test("primitives, with integer as number and validation keywords ignored", () => {
    expect(jsonSchemaToTs({ type: "string", format: "date-time", pattern: "^x" })).toBe("string");
    expect(jsonSchemaToTs({ type: "integer", minimum: 0 })).toBe("number");
    expect(jsonSchemaToTs({ type: "number" })).toBe("number");
    expect(jsonSchemaToTs({ type: "boolean" })).toBe("boolean");
    expect(jsonSchemaToTs({ type: "null" })).toBe("null");
  });

  test("const and enum become literals", () => {
    expect(jsonSchemaToTs({ type: "string", const: "x" })).toBe('"x"');
    expect(jsonSchemaToTs({ const: null })).toBe("null");
    expect(jsonSchemaToTs({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(jsonSchemaToTs({ enum: [1, true, null] })).toBe("1 | true | null");
  });

  test("anyOf and oneOf become unions", () => {
    const nullable = { anyOf: [{ type: "string" }, { type: "null" }] };
    expect(jsonSchemaToTs(nullable)).toBe("string | null");
    expect(jsonSchemaToTs({ oneOf: [{ const: "a" }, { const: "b" }] })).toBe('"a" | "b"');
  });

  test("a type array applies the rest of the schema to each type", () => {
    expect(jsonSchemaToTs({ type: ["string", "null"] })).toBe("string | null");
    expect(jsonSchemaToTs({ type: ["array", "null"], items: { type: "string" } })).toBe(
      "string[] | null",
    );
  });

  test("allOf becomes an intersection, parenthesizing unions", () => {
    const schema = {
      allOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { type: "string" }],
    };
    expect(jsonSchemaToTs(schema)).toBe("(string | number) & string");
  });

  test("objects mark properties optional unless required and quote non-identifier keys", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string" }, "x-count": { type: "number" }, $tag: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    };
    expect(jsonSchemaToTs(schema)).toBe('{\n  id: string;\n  "x-count"?: number;\n  $tag?: string;\n}');
  });

  test("nested objects indent one level per depth", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "object", properties: { b: { type: "boolean" } }, required: ["b"] },
      },
      required: ["a"],
    };
    expect(jsonSchemaToTs(schema)).toBe("{\n  a: {\n    b: boolean;\n  };\n}");
    expect(jsonSchemaToTs(schema, { indent: 2 })).toBe(
      "{\n      a: {\n        b: boolean;\n      };\n    }",
    );
  });

  test("records and open objects", () => {
    const record = { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "number" } };
    expect(jsonSchemaToTs(record)).toBe("Record<string, number>");
    expect(jsonSchemaToTs({ type: "object" })).toBe("Record<string, unknown>");
    expect(jsonSchemaToTs({ type: "object", properties: {}, additionalProperties: false })).toBe(
      "Record<string, never>",
    );
    const loose = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: {},
    };
    expect(jsonSchemaToTs(loose)).toBe("{\n  a: string;\n  [key: string]: unknown;\n}");
  });

  test("arrays", () => {
    expect(jsonSchemaToTs({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(
      jsonSchemaToTs({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }),
    ).toBe("(string | number)[]");
    expect(jsonSchemaToTs({ type: "array" })).toBe("unknown[]");
  });

  test("a bare prefixItems is a fixed tuple; explicit minItems, maxItems and items loosen it", () => {
    const pair = { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] };
    expect(jsonSchemaToTs(pair)).toBe("[string, number]");
    expect(jsonSchemaToTs({ ...pair, minItems: 2, maxItems: 2 })).toBe("[string, number]");
    expect(jsonSchemaToTs({ ...pair, minItems: 1, items: false })).toBe("[string, number?]");
    expect(jsonSchemaToTs({ ...pair, minItems: 1, maxItems: 1 })).toBe("[string]");
    expect(jsonSchemaToTs({ ...pair, minItems: 2, items: { type: "boolean" } })).toBe(
      "[string, number, ...boolean[]]",
    );
    const union = { anyOf: [{ type: "string" }, { type: "null" }] };
    expect(jsonSchemaToTs({ type: "array", prefixItems: [union], minItems: 0 })).toBe("[(string | null)?]");
    expect(jsonSchemaToTs({ type: "array", prefixItems: [] })).toBe("[]");
    expect(jsonSchemaToTs({ type: "array", prefixItems: [], items: { type: "string" } })).toBe("string[]");
  });

  test("tuples as zod emits them, with no minItems", () => {
    expect(jsonSchemaToTs(z.toJSONSchema(z.tuple([z.string(), z.number()])))).toBe("[string, number]");
    const rest = z.tuple([z.string()], z.boolean());
    expect(jsonSchemaToTs(z.toJSONSchema(rest))).toBe("[string, ...boolean[]]");
  });

  test("$ref uses refName, and unnamed refs become unknown", () => {
    const schema = { $ref: "#/components/schemas/Node" };
    expect(jsonSchemaToTs(schema)).toBe("unknown");
    expect(jsonSchemaToTs(schema, { refName: (ref) => (ref.endsWith("/Node") ? "Node" : undefined) })).toBe(
      "Node",
    );
  });

  test("anything else becomes unknown, and false becomes never", () => {
    expect(jsonSchemaToTs({})).toBe("unknown");
    expect(jsonSchemaToTs(true)).toBe("unknown");
    expect(jsonSchemaToTs(false)).toBe("never");
    expect(jsonSchemaToTs({ not: { type: "string" } })).toBe("unknown");
    expect(jsonSchemaToTs({ type: "bigint" })).toBe("unknown");
    expect(jsonSchemaToTs("nonsense")).toBe("unknown");
  });

  test("a property named __proto__ is kept", () => {
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}');
    expect(jsonSchemaToTs(schema)).toBe("{\n  __proto__: string;\n}");
  });

  test("type names that are Object.prototype members are unknown", () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(jsonSchemaToTs({ type })).toBe("unknown");
    }
  });

  test("repeated types in a type array collapse", () => {
    expect(jsonSchemaToTs({ type: ["string", "string", "null"] })).toBe("string | null");
    expect(jsonSchemaToTs({ type: ["integer", "number"] })).toBe("number");
  });

  test("a repeated object type nested deep stays linear", () => {
    let schema: unknown = { type: "string" };
    for (let depth = 0; depth < 30; depth++) {
      schema = { type: ["object", "object"], properties: { a: schema }, required: ["a"] };
    }
    expect(jsonSchemaToTs(schema).length).toBeLessThan(10_000);
  });

  test("refuses types past the size cap", () => {
    // Each level doubles: a tuple repeats its member, which a union dedupe can't collapse.
    let schema: unknown = { type: "string" };
    for (let depth = 0; depth < 30; depth++) {
      schema = { type: "array", prefixItems: [schema, schema] };
    }
    expect(() => jsonSchemaToTs(schema)).toThrow("a schema generates over 5,000,000 characters of types");
  });
});

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { hashDocument } from "../src/cli/hash";
import { toOpenAPI } from "../src/cli/openapi";
import { billingDocument } from "./fixtures/billing";

const info = { title: "Test", version: "1.0.0" };

describe("toOpenAPI", () => {
  test("wraps each event's schema in the webhooks envelope", () => {
    const document = toOpenAPI(
      { "invoice.paid": z.object({ invoiceId: z.string() }) },
      { ...info, description: "Test events" },
    );
    expect(document).toEqual({
      openapi: "3.1.0",
      info: { title: "Test", version: "1.0.0", description: "Test events" },
      webhooks: {
        "invoice.paid": {
          post: {
            operationId: "invoice.paid",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      event: { type: "string", const: "invoice.paid" },
                      subject: { type: ["string", "null"] },
                      data: {
                        type: "object",
                        properties: { invoiceId: { type: "string" } },
                        required: ["invoiceId"],
                        additionalProperties: false,
                      },
                    },
                    required: ["event", "subject", "data"],
                    additionalProperties: false,
                  },
                },
              },
            },
            responses: { "2XX": { description: "Return any 2XX status to acknowledge the event" } },
          },
        },
      },
    });
  });

  test("lists webhooks in name order and omits components when nothing is hoisted", () => {
    const document = toOpenAPI({ b: z.string(), a: z.number() }, info);
    expect(Object.keys(document.webhooks)).toEqual(["a", "b"]);
    expect(document.components).toBeUndefined();
  });

  test("hoists $defs and root self-references into components, namespaced by event", () => {
    expect(Object.keys(billingDocument.components?.schemas ?? {})).toEqual([
      "category.created",
      "price.created.__schema0",
    ]);
    const text = JSON.stringify(billingDocument);
    expect(text).not.toContain("#/$defs/");
    expect(text).not.toContain('"$ref":"#"');
    expect(text).not.toContain("$schema");

    const categoryData = billingDocument.webhooks["category.created"];
    expect(JSON.stringify(categoryData)).toContain('"data":{"$ref":"#/components/schemas/category.created"}');
    expect(billingDocument.components?.schemas["category.created"]).toMatchObject({
      properties: { parent: { $ref: "#/components/schemas/category.created" } },
    });
    expect(billingDocument.components?.schemas["price.created.__schema0"]).toMatchObject({
      properties: { next: { $ref: "#/components/schemas/price.created.__schema0" } },
    });
  });

  test("returns plain JSON, so it hashes like the document the registry receives", async () => {
    const document = toOpenAPI(
      { "invoice.paid": z.object({ paidAt: z.iso.datetime().meta({ examples: [new Date(0)] }) }) },
      info,
    );
    expect(JSON.stringify(document)).toContain('"examples":["1970-01-01T00:00:00.000Z"]');
    expect(await hashDocument(document)).toBe(await hashDocument(JSON.parse(JSON.stringify(document))));
  });

  test("fails when two events hoist to the same component name", () => {
    function withDefs(defs: Record<string, unknown>) {
      const output = () => ({ $defs: defs, type: "string" });
      return { "~standard": { jsonSchema: { output } } };
    }
    const events = { a: withDefs({ "b.c": { type: "string" } }), "a.b": withDefs({ c: {} }) };
    expect(() => toOpenAPI(events, info)).toThrow(
      'events "a" and "a.b" both define the component schema "a.b.c"; rename one of them',
    );
  });

  test("accepts schemas that are functions, like ArkType's", () => {
    const output = () => ({ type: "string" });
    const functionSchema = Object.assign(() => {}, { "~standard": { jsonSchema: { output } } });
    const document = toOpenAPI({ "user.created": functionSchema }, info);
    expect(JSON.stringify(document.webhooks)).toContain('"data":{"type":"string"}');
  });

  test("names the event when its schema can't become JSON Schema", () => {
    expect(() => toOpenAPI({ "thing.happened": z.object({ at: z.date() }) }, info)).toThrow(
      /event "thing.happened" can't be converted to JSON Schema: Date cannot be represented/,
    );
  });

  test("names the event when its schema has no Standard JSON Schema converter", () => {
    const standardSchemaOnly = { "~standard": { version: 1, vendor: "x", validate: () => ({ value: 1 }) } };
    expect(() => toOpenAPI({ "user.created": standardSchemaOnly }, info)).toThrow(
      /event "user.created": schema doesn't implement Standard JSON Schema/,
    );
  });
});

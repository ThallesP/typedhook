import { describe, expect, test } from "bun:test";
import { readRegistryDocument } from "../src/registry/model";
import { goPackageName } from "../src/registry/names";

function webhook(payload: unknown, operation: Record<string, unknown> = {}) {
  return { post: { ...operation, requestBody: { content: { "application/json": { schema: payload } } } } };
}

function document(webhooks: Record<string, unknown>, schemas: Record<string, unknown> = {}) {
  return { openapi: "3.1.0", info: { title: "x", version: "1.0.0" }, webhooks, components: { schemas } };
}

function typed(property: string, value: string, extra: Record<string, unknown> = {}) {
  return { type: "object", properties: { [property]: { const: value }, ...extra } };
}

describe("readRegistryDocument", () => {
  test("reads events sorted by name with their descriptions", () => {
    const model = readRegistryDocument(
      "acme/x",
      document({
        "b.happened": webhook({ type: "object" }, { summary: "B happened" }),
        "a.happened": webhook({ type: "object", description: "A happened" }),
      }),
    );
    expect(model.events.map((event) => [event.name, event.description])).toEqual([
      ["a.happened", "A happened"],
      ["b.happened", "B happened"],
    ]);
  });

  test("prefers the property that holds each event's own name", () => {
    const model = readRegistryDocument(
      "acme/x",
      document({
        "invoice.paid": webhook(typed("event", "invoice.paid", { object: { const: "event" } })),
        "invoice.voided": webhook(typed("event", "invoice.voided", { object: { const: "event" } })),
      }),
    );
    expect(model.discriminator).toEqual({
      property: "event",
      values: { "invoice.paid": "invoice.paid", "invoice.voided": "invoice.voided" },
    });
  });

  test("falls back to any property with a distinct const per event", () => {
    const model = readRegistryDocument(
      "acme/x",
      document({
        InvoicePaid: webhook(typed("type", "invoice.paid", { object: { const: "event" } })),
        InvoiceVoided: webhook({ allOf: [{ $ref: "#/components/schemas/Base" }, typed("type", "invoice.voided")] }),
      }, { Base: { type: "object", properties: { object: { enum: ["event"] } } } }),
    );
    expect(model.discriminator).toEqual({
      property: "type",
      values: { InvoicePaid: "invoice.paid", InvoiceVoided: "invoice.voided" },
    });
  });

  test("looks through a payload that is a $ref", () => {
    const model = readRegistryDocument(
      "acme/x",
      document(
        { push: webhook({ $ref: "#/components/schemas/Push" }) },
        { Push: typed("kind", "push") },
      ),
    );
    expect(model.discriminator).toEqual({ property: "kind", values: { push: "push" } });
  });

  test("has no discriminator when the events don't all name themselves", () => {
    const model = readRegistryDocument(
      "acme/x",
      document({
        push: webhook({ type: "object", properties: { ref: { type: "string" } } }),
        star: webhook(typed("action", "created")),
      }),
    );
    expect(model.discriminator).toBeNull();
    const shared = readRegistryDocument(
      "acme/x",
      document({ a: webhook(typed("object", "event")), b: webhook(typed("object", "event")) }),
    );
    expect(shared.discriminator).toBeNull();
  });

  test("survives self-referencing components", () => {
    const model = readRegistryDocument(
      "acme/x",
      document({ a: webhook({ $ref: "#/components/schemas/Loop" }) }, { Loop: { $ref: "#/components/schemas/Loop" } }),
    );
    expect(model.discriminator).toBeNull();
  });

  test("rejects documents without webhooks or with webhooks it can't read", () => {
    expect(() => readRegistryDocument("acme/x", { openapi: "3.1.0" })).toThrow(
      "acme/x: the document has no webhooks object",
    );
    expect(() => readRegistryDocument("acme/x", document({ a: { post: {} } }))).toThrow(
      'webhook "a" has no application/json request body',
    );
  });
});

describe("goPackageName", () => {
  test("never a keyword, builtin or a name the go tool treats specially", () => {
    expect(["user-accounts", "1password", "init", "documentation", "string", "len", "main", "type"].map(goPackageName)).toEqual([
      "useraccounts",
      "x1password",
      "xinit",
      "xdocumentation",
      "xstring",
      "xlen",
      "xmain",
      "xtype",
    ]);
  });
});

describe("readRegistryDocument with one event", () => {
  const one = (properties: Record<string, unknown>) =>
    readRegistryDocument("acme/x", document({ InvoicePaid: webhook({ type: "object", properties }) }));

  test("takes a usual discriminator name, not another const", () => {
    expect(one({ object: { const: "event" }, type: { const: "invoice.paid" } }).discriminator).toEqual({
      property: "type",
      values: { InvoicePaid: "invoice.paid" },
    });
    expect(one({ action: { const: "created" } }).discriminator).toBeNull();
  });
});

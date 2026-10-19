import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type SchemaChange, diffDocuments, isBumpEnough, nextVersion, versionBump } from "../src/registry/diff";
import { toOpenAPI } from "../src/registry/openapi";

function document(events: Record<string, z.ZodType>, version = "1.0.0") {
  return JSON.parse(JSON.stringify(toOpenAPI(events, { title: "Billing", version })));
}

const paid = z.object({
  invoiceId: z.string(),
  amountCents: z.int(),
  status: z.enum(["paid", "refunded"]),
  note: z.string().optional(),
});

describe("diffDocuments", () => {
  test("nothing changed, whatever the version", () => {
    expect(diffDocuments(document({ "invoice.paid": paid }), document({ "invoice.paid": paid }, "1.0.1"))).toEqual({
      bump: null,
      changes: [],
    });
  });

  test("events added are minor, removed are major", () => {
    const diff = diffDocuments(
      document({ "invoice.paid": paid, "invoice.voided": z.object({}) }),
      document({ "invoice.paid": paid, "invoice.sent": z.object({}) }),
    );
    expect(diff).toEqual({
      bump: "major",
      changes: [
        { bump: "major", event: "invoice.voided", path: "", message: "removed" },
        { bump: "minor", event: "invoice.sent", path: "", message: "added" },
      ],
    });
  });

  test("what consumers relied on going away is major", () => {
    const next = z.object({
      invoiceId: z.string().optional(),
      amountCents: z.number(),
      status: z.string(),
    });
    const diff = diffDocuments(document({ "invoice.paid": paid }), document({ "invoice.paid": next }));
    expect(diff.bump).toBe("major");
    expect(diff.changes.map(({ path, message }) => `${path} ${message}`)).toEqual([
      "data.invoiceId is now optional",
      "data.amountCents can now be a number",
      "data.amountCents can no longer be an integer",
      "data.status can now be a string",
      'data.status can no longer be "paid"',
      'data.status can no longer be "refunded"',
      "data.note was removed",
    ]);
  });

  test("new fields, enum values and narrower types are minor", () => {
    const next = z.object({
      invoiceId: z.string(),
      amountCents: z.int(),
      status: z.enum(["paid", "refunded", "disputed"]),
      note: z.string(),
      currency: z.string(),
    });
    const diff = diffDocuments(document({ "invoice.paid": paid }), document({ "invoice.paid": next }));
    expect(diff).toEqual({
      bump: "minor",
      changes: [
        { bump: "minor", event: "invoice.paid", path: "data.status", message: 'has a new value "disputed"' },
        { bump: "minor", event: "invoice.paid", path: "data.note", message: "is now always sent" },
        { bump: "minor", event: "invoice.paid", path: "data.currency", message: "was added" },
      ],
    });
  });

  test("nullable is major, dropping null is minor", () => {
    const before = document({ a: z.object({ x: z.string(), y: z.string().nullable() }) });
    const after = document({ a: z.object({ x: z.string().nullable(), y: z.string() }) });
    expect(diffDocuments(before, after).changes).toEqual([
      { bump: "major", event: "a", path: "data.x", message: "can now be null" },
      { bump: "minor", event: "a", path: "data.y", message: "can no longer be null" },
    ]);
  });

  test("descriptions alone are a patch", () => {
    const before = document({ a: z.object({ x: z.string() }) });
    const after = document({ a: z.object({ x: z.string().describe("The x") }) });
    expect(diffDocuments(before, after)).toEqual({
      bump: "patch",
      changes: [{ bump: "patch", event: "", path: "", message: "title, descriptions or examples changed" }],
    });
  });

  test("compares recursive schemas and arrays without looping", () => {
    const Category: z.ZodType = z.object({
      name: z.string(),
      get children() {
        return z.array(Category);
      },
    });
    const Next: z.ZodType = z.object({
      name: z.string(),
      slug: z.string(),
      get children() {
        return z.array(Next);
      },
    });
    const diff = diffDocuments(document({ "category.created": Category }), document({ "category.created": Next }));
    expect(diff.bump).toBe("minor");
    expect(diff.changes.map((change) => change.path)).toEqual(["data.slug"]);
  });

  test("works on payloads that aren't the typedhook envelope", () => {
    const doc = (properties: Record<string, unknown>) => ({
      openapi: "3.1.0",
      info: { title: "x", version: "1.0.0" },
      webhooks: {
        push: { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties, required: ["ref"] } } } } } },
      },
    });
    const diff = diffDocuments(doc({ ref: { type: "string" } }), doc({ ref: { type: "integer" } }));
    expect(diff.changes).toEqual([
      { bump: "major", event: "push", path: "ref", message: "can now be an integer" },
      { bump: "minor", event: "push", path: "ref", message: "can no longer be a string" },
    ]);
  });
});

describe("versions", () => {
  test("nextVersion", () => {
    expect(nextVersion("1.4.2", "major")).toBe("2.0.0");
    expect(nextVersion("1.4.2", "minor")).toBe("1.5.0");
    expect(nextVersion("1.4.2", "patch")).toBe("1.4.3");
    expect(nextVersion("2.0.0-beta.1", "minor")).toBe("2.0.0");
    expect(() => nextVersion("v1", "patch")).toThrow("invalid version");
  });

  test("versionBump and isBumpEnough", () => {
    expect(versionBump("1.4.2", "2.0.0")).toBe("major");
    expect(versionBump("1.4.2", "1.5.0")).toBe("minor");
    expect(versionBump("1.4.2", "1.4.3")).toBe("patch");
    expect(versionBump("1.4.2", "1.4.2")).toBeNull();
    expect(versionBump("1.4.2", "1.3.9")).toBeNull();
    expect(isBumpEnough("minor", "major")).toBe(false);
    expect(isBumpEnough("major", "minor")).toBe(true);
    expect(isBumpEnough(null, null)).toBe(true);
  });
});

describe("diffDocuments and the discriminator", () => {
  const webhook = (properties: Record<string, unknown>) => ({
    post: { requestBody: { content: { "application/json": { schema: { type: "object", properties } } } } },
  });
  const doc = (webhooks: Record<string, unknown>) => ({ openapi: "3.1.0", info: { title: "x", version: "1.0.0" }, webhooks });

  test("losing the discriminator is major, even when the change is an added event", () => {
    const before = doc({ star: webhook({ type: { const: "star" } }) });
    const after = doc({ star: webhook({ type: { const: "star" } }), watch: webhook({ type: { const: "star" } }) });
    expect(diffDocuments(before, after)).toEqual({
      bump: "major",
      changes: [
        { bump: "major", event: "", path: "", message: 'events are no longer named by "type"' },
        { bump: "minor", event: "watch", path: "", message: "added" },
      ],
    });
  });

  test("a renamed discriminator value re-keys the event, which is major", () => {
    const before = doc({ InvoicePaid: webhook({ type: { const: "invoice.paid" } }), Other: webhook({ type: { const: "other" } }) });
    const after = doc({ InvoicePaid: webhook({ type: { const: "invoice.succeeded" } }), Other: webhook({ type: { const: "other" } }) });
    expect(diffDocuments(before, after).changes).toContainEqual({
      bump: "major",
      event: "InvoicePaid",
      path: "",
      message: 'is now keyed "invoice.succeeded"',
    });
  });

  test("one event doesn't pick an unrelated const as the discriminator", () => {
    const before = doc({ star: webhook({ action: { const: "created" } }) });
    const after = doc({ star: webhook({ action: { const: "created" } }), watch: webhook({ action: { const: "started" } }) });
    expect(diffDocuments(before, after).changes[0]).toEqual({
      bump: "major",
      event: "",
      path: "",
      message: 'events are now named by "action"',
    });
  });
});

describe("diffDocuments from the review's cases", () => {
  test("unions of objects pair up by their own discriminator", () => {
    const union = (extra: Record<string, z.ZodType>) =>
      z.object({
        item: z.union([
          z.object({ kind: z.literal("paid"), amount: z.number() }),
          z.object({ kind: z.literal("voided"), reason: z.string(), ...extra }),
        ]),
      });
    const unchanged = document({ a: union({ note: z.string() }) });
    expect(diffDocuments(unchanged, structuredClone(unchanged))).toEqual({ bump: null, changes: [] });
    expect(diffDocuments(unchanged, document({ a: union({}) })).changes).toEqual([
      { bump: "major", event: "a", path: "data.item.note", message: "was removed" },
    ]);
  });

  test("tuples, records, wrapped refs and removed components", () => {
    const tuple = diffDocuments(
      document({ a: z.object({ meter: z.tuple([z.string(), z.number()]) }) }),
      document({ a: z.object({ meter: z.tuple([z.number(), z.number()]) }) }),
    );
    expect(tuple.bump).toBe("major");
    expect(tuple.changes[0]).toMatchObject({ path: "data.meter[0]", message: "can now be a number" });
    const shorter = diffDocuments(
      document({ a: z.object({ meter: z.tuple([z.string(), z.number()]) }) }),
      document({ a: z.object({ meter: z.tuple([z.string()]) }) }),
    );
    expect(shorter.changes).toEqual([{ bump: "major", event: "a", path: "data.meter", message: "has 1 items instead of 2" }]);
    const record = diffDocuments(
      document({ a: z.object({ metadata: z.record(z.string(), z.string()) }) }),
      document({ a: z.object({ metadata: z.record(z.string(), z.union([z.string(), z.number()])) }) }),
    );
    expect(record.changes).toEqual([{ bump: "major", event: "a", path: "data.metadata[key]", message: "can now be a number" }]);

    const wrapped = (type: string) => ({
      openapi: "3.1.0",
      info: { title: "x", version: "1.0.0" },
      webhooks: {
        a: {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { id: { allOf: [{ $ref: "#/components/schemas/Id" }] } } },
                },
              },
            },
          },
        },
      },
      components: { schemas: { Id: { type }, ...(type === "string" ? { Old: { type: "string" } } : {}) } },
    });
    expect(diffDocuments(wrapped("string"), wrapped("integer")).changes).toEqual([
      { bump: "major", event: "a", path: "id", message: "can now be an integer" },
      { bump: "minor", event: "a", path: "id", message: "can no longer be a string" },
      { bump: "major", event: "", path: "Old", message: "type was removed" },
    ]);
  });

  test("a title change is a patch, and null joining an enum is major", () => {
    const before = document({ a: z.object({ status: z.enum(["paid", "refunded"]) }) });
    const retitled = { ...structuredClone(before), info: { title: "Payments", version: "1.0.0" } };
    expect(diffDocuments(before, retitled).bump).toBe("patch");
    const nullable = document({ a: z.object({ status: z.enum(["paid", "refunded"]).nullable() }) });
    expect(diffDocuments(before, nullable).changes).toEqual([
      { bump: "major", event: "a", path: "data.status", message: "can now be null" },
    ]);
  });
});

describe("diffDocuments and union variants", () => {
  const paid = z.object({ kind: z.literal("paid"), amount: z.number() });
  const voided = z.object({ kind: z.literal("voided"), reason: z.string() });
  const disputed = z.object({ kind: z.literal("disputed"), caseId: z.string() });
  const item = (...variants: [z.ZodObject, z.ZodObject, ...z.ZodObject[]]) =>
    document({ a: z.object({ item: z.union(variants) }) });

  test("a new tagged variant is minor, wherever it's listed", () => {
    const added: SchemaChange = { bump: "minor", event: "a", path: "data.item", message: 'has a new variant kind="disputed"' };
    expect(diffDocuments(item(paid, voided), item(paid, voided, disputed))).toEqual({ bump: "minor", changes: [added] });
    expect(diffDocuments(item(paid, voided), item(disputed, paid, voided))).toEqual({ bump: "minor", changes: [added] });
    // Same types, different document: only a patch.
    expect(diffDocuments(item(paid, voided), item(voided, paid)).bump).toBe("patch");
  });

  test("a removed tagged variant is minor too", () => {
    expect(diffDocuments(item(paid, voided, disputed), item(paid, voided)).changes).toEqual([
      { bump: "minor", event: "a", path: "data.item", message: 'no longer has the variant kind="disputed"' },
    ]);
  });

  test("an unchanged union of arrays is no change", () => {
    const arrays = document({ a: z.object({ item: z.union([z.array(z.string()), z.array(z.number())]) }) });
    expect(diffDocuments(arrays, structuredClone(arrays))).toEqual({ bump: null, changes: [] });
  });

  test("integer | number against number changes no types", () => {
    const before = document({ a: z.object({ n: z.number() }) });
    const after = document({ a: z.object({ n: z.union([z.int(), z.number()]) }) });
    expect(diffDocuments(before, after).bump).toBe("patch");
  });
});

describe("diffDocuments and tuple bounds", () => {
  const tuple = (bounds: Record<string, number>) => ({
    openapi: "3.1.0",
    info: { title: "x", version: "1.0.0" },
    webhooks: {
      a: {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { meter: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], ...bounds } },
                },
              },
            },
          },
        },
      },
    },
  });

  test("minItems making an item optional is major, and the reverse minor", () => {
    expect(diffDocuments(tuple({}), tuple({ minItems: 1 })).changes).toEqual([
      { bump: "major", event: "a", path: "meter[1]", message: "is now optional" },
    ]);
    expect(diffDocuments(tuple({ minItems: 1 }), tuple({})).bump).toBe("minor");
  });

  test("maxItems cutting an item is major", () => {
    expect(diffDocuments(tuple({}), tuple({ maxItems: 1 })).changes).toEqual([
      { bump: "major", event: "a", path: "meter", message: "has 1 items instead of 2" },
    ]);
  });
});

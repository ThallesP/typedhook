import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { diffDocuments, isBumpEnough, nextVersion, versionBump } from "../src/registry/diff";
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
      changes: [{ bump: "patch", event: "", path: "", message: "descriptions or examples changed" }],
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

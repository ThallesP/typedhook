import { describe, expect, test } from "bun:test";
import { WEBHOOKS_FILES, eventsFromModule } from "../src/registry/webhooks-module";

const events = { "invoice.paid": {} };
const otherEvents = { "user.created": {} };
const wh = { "~typedhook": { version: 1, events }, send() {} };
const other = { "~typedhook": { version: 1, events: otherEvents }, send() {} };

describe("eventsFromModule", () => {
  test("finds the instance under any export name", () => {
    expect(eventsFromModule({ webhookSender: wh, money: {} }, "webhooks.ts")).toBe(events);
  });

  test("counts an instance exported twice once", () => {
    expect(eventsFromModule({ wh, default: wh }, "webhooks.ts")).toBe(events);
  });

  test("takes a CommonJS module that is the instance itself", () => {
    expect(eventsFromModule(wh, "webhooks.cjs")).toBe(events);
  });

  test("picks the named export among several instances", () => {
    expect(eventsFromModule({ wh, other }, "webhooks.ts", "other")).toBe(otherEvents);
  });

  test("fails on several instances without a name", () => {
    expect(() => eventsFromModule({ wh, other }, "webhooks.ts")).toThrow(
      "webhooks.ts exports several webhooks() instances (wh, other); choose one with --export, or the action's export input",
    );
  });

  test("fails when nothing exported is an instance", () => {
    expect(() => eventsFromModule({ events }, "webhooks.ts")).toThrow(
      "webhooks.ts doesn't export a webhooks() instance from @typedhook/sdk",
    );
  });

  test("fails when the named export isn't an instance", () => {
    expect(() => eventsFromModule({ wh, events }, "webhooks.ts", "events")).toThrow(
      'webhooks.ts: export "events" isn\'t a webhooks() instance from @typedhook/sdk',
    );
  });

  test("ignores a brand from an unknown version", () => {
    const future = { "~typedhook": { version: 2, events } };
    expect(() => eventsFromModule({ future }, "webhooks.ts")).toThrow("doesn't export a webhooks() instance");
  });
});

test("WEBHOOKS_FILES looks in the project root first", () => {
  expect(WEBHOOKS_FILES[0]).toBe("webhooks.ts");
  expect(WEBHOOKS_FILES).toContain("src/lib/webhooks.ts");
});

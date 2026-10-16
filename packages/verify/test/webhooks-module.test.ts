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

  test("still applies export and the several-instances check to a CommonJS instance", () => {
    const primary = { ...wh, other };
    expect(eventsFromModule(primary, "webhooks.cjs", "other")).toBe(otherEvents);
    expect(() => eventsFromModule(primary, "webhooks.cjs")).toThrow(
      "webhooks.cjs exports several webhooks() instances (other, default)",
    );
  });

  test("unwraps CommonJS compiled from export default", () => {
    const compiled = { __esModule: true, default: { __esModule: true, default: wh } };
    expect(eventsFromModule(compiled, "webhooks.cjs")).toBe(events);
    expect(eventsFromModule(compiled, "webhooks.cjs", "default")).toBe(events);
  });

  test("treats a CommonJS instance as its own default, as Node does", () => {
    expect(eventsFromModule({ ...wh, default: other }, "webhooks.cjs")).toBe(events);
  });

  test("doesn't let a plain default object shadow named exports", () => {
    expect(eventsFromModule({ wh, default: { wh: other } }, "webhooks.ts", "wh")).toBe(events);
    expect(eventsFromModule({ wh, default: { wh: other } }, "webhooks.ts")).toBe(events);
  });

  test("reads CommonJS exports Node's namespace misses off module.exports", () => {
    const whole = { wh, other };
    expect(() => eventsFromModule({ default: whole, "module.exports": whole, wh }, "webhooks.cjs")).toThrow(
      "exports several webhooks() instances (wh, other)",
    );
    expect(eventsFromModule({ default: whole, "module.exports": whole, wh }, "webhooks.cjs", "other")).toBe(
      otherEvents,
    );
    expect(eventsFromModule({ default: { wh }, "module.exports": { wh } }, "webhooks.cjs")).toBe(events);
  });

  test("keeps an ESM namespace whose default object repeats a named export", () => {
    expect(eventsFromModule({ wh, default: { wh, other } }, "webhooks.ts")).toBe(events);
    expect(() => eventsFromModule({ wh, default: { wh, other } }, "webhooks.ts", "other")).toThrow(
      'export "other" isn\'t a webhooks() instance',
    );
  });

  test("stops at a default export that is the module itself", () => {
    const exports: Record<string, unknown> = { __esModule: true, wh };
    exports.default = exports;
    expect(eventsFromModule(exports, "webhooks.cjs", "wh")).toBe(events);
    expect(eventsFromModule({ default: exports, "module.exports": exports, wh }, "webhooks.cjs")).toBe(events);
  });

  test("points at the SDK upgrade for an instance without the brand", () => {
    expect(() => eventsFromModule({ wh: { send() {} } }, "webhooks.ts")).toThrow(
      "upgrade @typedhook/sdk to a version that marks its instances",
    );
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

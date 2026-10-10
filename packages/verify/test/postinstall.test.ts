import { describe, expect, test } from "bun:test";
import { withPostinstall } from "../src/cli/postinstall";

describe("withPostinstall", () => {
  test("adds scripts with the postinstall when there are none", () => {
    expect(withPostinstall('{ "name": "app" }')).toBe(
      '{\n  "name": "app",\n  "scripts": {\n    "postinstall": "typedhook pull"\n  }\n}\n',
    );
  });

  test("appends to an existing postinstall, keeping key order", () => {
    const text = JSON.stringify({
      name: "app",
      scripts: { build: "tsc", postinstall: "prisma generate", test: "bun test" },
      dependencies: {},
    });
    expect(JSON.parse(withPostinstall(text) ?? "")).toEqual({
      name: "app",
      scripts: { build: "tsc", postinstall: "prisma generate && typedhook pull", test: "bun test" },
      dependencies: {},
    });
  });

  test("sets the postinstall when the scripts have none", () => {
    const next = withPostinstall('{ "scripts": { "build": "tsc" } }');
    expect(JSON.parse(next ?? "").scripts).toEqual({ build: "tsc", postinstall: "typedhook pull" });
  });

  test("is null when the postinstall already pulls", () => {
    const text = '{ "scripts": { "postinstall": "prisma generate && typedhook pull" } }';
    expect(withPostinstall(text)).toBeNull();
  });

  test("keeps the file's indentation", () => {
    expect(withPostinstall('{\n\t"name": "app"\n}\n')).toBe(
      '{\n\t"name": "app",\n\t"scripts": {\n\t\t"postinstall": "typedhook pull"\n\t}\n}\n',
    );
  });
});

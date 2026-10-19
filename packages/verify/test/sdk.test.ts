import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashDocument } from "../src/registry/hash";
import { generatePackage } from "../src/registry/sdk";
import { billingDocument } from "./fixtures/billing";

const document = JSON.parse(JSON.stringify(billingDocument));
const input = { registry: "acme/billing", version: "1.4.0", hash: await hashDocument(document), document };

describe("generatePackage typescript", () => {
  test("is a package.json, tsconfig, the generated code and a README", async () => {
    const { packageName, files } = await generatePackage("typescript", input);
    expect(packageName).toBe("@acme/billing-webhooks");
    expect([...files.keys()]).toEqual(["package.json", "tsconfig.json", "src/index.ts", "README.md"]);
    expect(JSON.parse(files.get("package.json") ?? "")).toMatchObject({
      name: "@acme/billing-webhooks",
      version: "1.4.0",
      dependencies: { "@typedhook/verify": expect.stringMatching(/^\^/) },
    });
    const readme = files.get("README.md") ?? "";
    expect(readme).toContain("# Billing webhooks");
    expect(readme).toContain("npm install @acme/billing-webhooks");
    expect(readme).toContain('import { createBillingWebhooks } from "@acme/billing-webhooks";');
    expect(readme).toContain("| `invoice.paid` |");
  });

  test("takes a package name", async () => {
    const { files } = await generatePackage("typescript", input, { packageName: "acme-webhooks" });
    expect(JSON.parse(files.get("package.json") ?? "")).toMatchObject({ name: "acme-webhooks" });
  });

  test("type-checks against @typedhook/verify", async () => {
    const { files } = await generatePackage("typescript", input);
    const dir = await mkdtemp(join(import.meta.dir, "..", ".test-sdk-"));
    for (const [path, text] of files) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    // Stands in for the installed @typedhook/verify.
    const paths = { "@typedhook/verify": [join(import.meta.dir, "../src/index.ts")] };
    const config = { extends: "./tsconfig.json", compilerOptions: { paths, noEmit: true } };
    await writeFile(join(dir, "tsconfig.test.json"), JSON.stringify(config));
    const tsc = Bun.spawnSync(["bunx", "tsc", "-p", join(dir, "tsconfig.test.json")], { cwd: dir });
    await rm(dir, { recursive: true });
    expect(tsc.stdout.toString()).toBe("");
    expect(tsc.exitCode).toBe(0);
  }, 30_000);
});

describe("generatePackage python and go", () => {
  test("python is a pyproject package with the module under src", async () => {
    const { packageName, files } = await generatePackage("python", input);
    expect(packageName).toBe("acme-billing-webhooks");
    expect([...files.keys()]).toEqual([
      "pyproject.toml",
      "src/acme_billing_webhooks/__init__.py",
      "src/acme_billing_webhooks/py.typed",
      "README.md",
    ]);
    expect(files.get("pyproject.toml")).toContain('name = "acme-billing-webhooks"\nversion = "1.4.0"');
    expect(files.get("README.md")).toContain('if event["event"] == "category.created":');
  });

  test("go is a module with the package at its root", async () => {
    const { packageName, files } = await generatePackage("go", input, { packageName: "github.com/acme/billing-go" });
    expect(packageName).toBe("github.com/acme/billing-go");
    expect([...files.keys()]).toEqual(["go.mod", "billing.go", "README.md"]);
    expect(files.get("go.mod")).toBe("module github.com/acme/billing-go\n\ngo 1.21\n");
    expect(files.get("README.md")).toContain("case *billing.CategoryCreated:");
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/is-record";

const tempDirectory = await mkdtemp(join(tmpdir(), "publish-action-"));

afterAll(() => rm(tempDirectory, { recursive: true, force: true }));

// Runs the committed bundle, copied away from any node_modules, the way the runner does.
describe("dist/index.js", () => {
  test("builds the document from a TypeScript events file in a dry run", async () => {
    await cp(join(import.meta.dir, "../dist"), join(tempDirectory, "dist"), { recursive: true });
    const outputFile = join(tempDirectory, "openapi.json");
    const githubOutput = join(tempDirectory, "github-output");
    const stepSummary = join(tempDirectory, "step-summary");
    await writeFile(githubOutput, "");
    await writeFile(stepSummary, "");

    const child = Bun.spawnSync(["node", join(tempDirectory, "dist/index.js")], {
      cwd: tempDirectory,
      env: {
        PATH: process.env.PATH,
        INPUT_EVENTS: "fixtures/events.ts",
        "INPUT_WORKING-DIRECTORY": import.meta.dir,
        INPUT_NAME: "billing",
        INPUT_VERSION: "1.4.0",
        "INPUT_DRY-RUN": "true",
        "INPUT_OUTPUT-FILE": outputFile,
        GITHUB_OUTPUT: githubOutput,
        GITHUB_STEP_SUMMARY: stepSummary,
        GITHUB_REPOSITORY_OWNER: "acme",
      },
    });
    expect(child.stdout.toString()).toContain("acme/billing@1.4.0: dry-run");
    expect(child.exitCode).toBe(0);

    const document: unknown = JSON.parse(await readFile(outputFile, "utf8"));
    expect(document).toMatchObject({ openapi: "3.1.0", info: { title: "billing", version: "1.4.0" } });
    const webhooks = isRecord(document) && isRecord(document.webhooks) ? Object.keys(document.webhooks) : [];
    expect(webhooks).toEqual(["invoice.paid", "invoice.voided"]);

    const outputs = await readFile(githubOutput, "utf8");
    expect(outputs).toMatch(/^status<<(\S+)\ndry-run\n\1$/m);
    expect(outputs).toMatch(/^registry<<(\S+)\nacme\/billing\n\1$/m);
    expect(await readFile(stepSummary, "utf8")).toContain("npx typedhook add acme/billing@^1.4.0");
  });
});

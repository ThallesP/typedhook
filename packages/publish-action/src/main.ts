import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as core from "@actions/core";
import {
  hashDocument,
  type OpenAPIInfo,
  pushDocument,
  toOpenAPI,
} from "@typedhook/verify/registry";
import { parseInputs } from "./inputs";
import { loadEvents } from "./load-events";

type Published = { status: "created" | "unchanged" | "dry-run"; version: string; hash: string };

export async function run(): Promise<void> {
  const inputs = parseInputs((name) => core.getInput(name), process.env);
  const workingDirectory = resolve(inputs.workingDirectory);
  const events = await loadEvents(resolve(workingDirectory, inputs.events), inputs.exportName);

  // No description key at all when unset: an undefined value would change the hash.
  const info: OpenAPIInfo = { title: inputs.title, version: inputs.version };
  if (inputs.description) info.description = inputs.description;
  const document = toOpenAPI(events, info);

  if (inputs.outputFile) {
    const outputPath = resolve(workingDirectory, inputs.outputFile);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  }

  const published: Published = inputs.isDryRun
    ? { status: "dry-run", version: inputs.version, hash: await hashDocument(document) }
    : await pushDocument({
        registryUrl: inputs.registryUrl,
        registry: inputs.registry,
        version: inputs.version,
        document,
        token: await core.getIDToken(inputs.registryUrl),
      });

  core.setOutput("registry", inputs.registry);
  core.setOutput("version", published.version);
  core.setOutput("hash", published.hash);
  core.setOutput("status", published.status);
  core.info(`${inputs.registry}@${published.version}: ${published.status} (${published.hash})`);
  await writeSummary(inputs.registry, published);
}

async function writeSummary(registry: string, { status, version, hash }: Published): Promise<void> {
  await core.summary
    .addHeading(`${registry}@${version}`, 3)
    .addTable([
      [
        { data: "Status", header: true },
        { data: "Hash", header: true },
      ],
      [status, `<code>${hash}</code>`],
    ])
    .addRaw("Consumers add it with:", true)
    .addCodeBlock(`npx typedhook add ${registry}@^${version}`, "sh")
    .write();
}

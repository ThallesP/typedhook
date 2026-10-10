#!/usr/bin/env node
import { parseArgs } from "node:util";
import { add } from "./commands/add";
import { pull } from "./commands/pull";
import { push } from "./commands/push";

const USAGE = `Usage: typedhook <command> [options]

Commands:
  add <owner/name[@range]>...  Add registries to typedhook.json and generate their types
    --registry <url>           Registry URL to save in typedhook.json

  pull                         Generate the types for every registry in typedhook.json
    --update                   Move each registry to the newest version its range allows
    --check                    Write nothing; fail when generated files are missing or stale

  push                         Build an OpenAPI document from your events and upload it
    --events <file>            Module exporting the event map (required); a .ts file
                               needs Bun or Node 22.18+
    --name <name>              Registry name (required)
    --version <semver>         Version to publish (required)
    --export <name>            Export holding the event map (default: events)
    --title <text>             OpenAPI info.title (default: the name)
    --description <text>       OpenAPI info.description
    --owner <owner>            Registry owner (default: $GITHUB_REPOSITORY_OWNER)
    --out <file>               Write the document to a file instead of uploading it

Environment:
  TYPEDHOOK_REGISTRY_URL        Registry URL, over the one in typedhook.json
  TYPEDHOOK_OIDC_TOKEN          Token for push; in GitHub Actions one is requested
                               (needs \`permissions: id-token: write\`)`;

const commands = new Map([
  ["add", runAdd],
  ["pull", runPull],
  ["push", runPush],
]);

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const run = commands.get(command);
  if (!run) throw new Error(`unknown command "${command}", see \`typedhook --help\``);
  await run(args);
}

async function runAdd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { registry: { type: "string" } },
  });
  await add(positionals, { registryUrl: values.registry });
}

async function runPull(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { update: { type: "boolean" }, check: { type: "boolean" } },
  });
  await pull(values);
}

async function runPush(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      events: { type: "string" },
      name: { type: "string" },
      version: { type: "string" },
      export: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      owner: { type: "string" },
      out: { type: "string" },
    },
  });
  const { events, name, version, export: exportName, ...rest } = values;
  if (!events || !name || !version) throw new Error("push needs --events, --name and --version");
  await push({ events, name, version, exportName, ...rest });
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`typedhook: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

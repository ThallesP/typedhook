#!/usr/bin/env node
import { parseArgs } from "node:util";
import { parseLang } from "@typedhook/verify/registry";
import { add } from "./commands/add";
import { info } from "./commands/info";
import { login } from "./commands/login";
import { logout } from "./commands/logout";
import { publish } from "./commands/publish";
import { pull } from "./commands/pull";
import { sdk } from "./commands/sdk";
import { search } from "./commands/search";
import { whoami } from "./commands/whoami";

const USAGE = `Usage: typedhook <command> [options]

Publish the webhooks your product sends:
  login                        Sign in with GitHub (prints a code to enter on github.com)
  publish                      Publish your events; the version is picked from what changed
    --events <file>            A module exporting zod, valibot or arktype schemas
      --export <name>          The export holding them (default: events)
    --openapi <file>           An OpenAPI 3.1 document (JSON or YAML) with webhooks
    --schemas <dir>            One JSON Schema per event: <dir>/invoice.paid.json
    --examples <dir>           Example payloads per event; the schema is inferred
    --name <name>              Registry name (default: package.json name or the directory)
    --owner <owner>            GitHub user or org to publish as (default: you)
    --version <semver>         Publish this version instead of the computed one
    --title <text>             Title (default: the name)
    --description <text>       Description
    --dry-run                  Show what would be published, upload nothing
    --out <file>               Also write the document to a file
  whoami                       Who you're signed in as and who you can publish as
  logout                       Sign out and revoke the token

Use other products' webhooks:
  search [query]               Find products that publish their webhooks
  info <owner/name[@range]>    A product's events and versions
  add <owner/name[@range]>...  Add products to typedhook.json and generate their code
    --lang <lang>              typescript (default), python or go
    --registry <url>           Registry URL to save in typedhook.json
  pull                         Generate the code for every product in typedhook.json
    --update                   Move each one to the newest version its range allows
    --check                    Write nothing; fail when generated files are missing or stale

Ship your own SDK:
  sdk <owner/name[@range]>     Write a package to publish under your name (npm, PyPI, Go)
    --lang <lang>              typescript, python or go (required)
    --out <dir>                Where to write it (required)
    --package <name>           npm/PyPI name or Go module path (default: @owner/name-webhooks,
                               owner-name-webhooks, github.com/owner/name-webhooks-go)

Flags given to publish are saved in typedhook.json, so later it's just \`typedhook publish\`.

Environment:
  TYPEDHOOK_REGISTRY_URL       Registry URL, over the one in typedhook.json
  TYPEDHOOK_TOKEN              A token from \`typedhook login\` (~/.config/typedhook), for publish
                               outside GitHub Actions; valid 90 days, 7 for organizations,
                               and revoked by that person's next login
  TYPEDHOOK_OIDC_TOKEN         GitHub OIDC token for publish; in GitHub Actions one is
                               requested (needs \`permissions: id-token: write\`)`;

const commands = new Map([
  ["login", runLogin],
  ["logout", runLogout],
  ["whoami", runWhoami],
  ["publish", runPublish],
  ["search", runSearch],
  ["info", runInfo],
  ["add", runAdd],
  ["pull", runPull],
  ["sdk", runSdk],
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

async function runLogin(args: string[]): Promise<void> {
  parseArgs({ args });
  await login();
}

async function runLogout(args: string[]): Promise<void> {
  parseArgs({ args });
  await logout();
}

async function runWhoami(args: string[]): Promise<void> {
  parseArgs({ args });
  await whoami();
}

async function runPublish(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      events: { type: "string" },
      export: { type: "string" },
      openapi: { type: "string" },
      schemas: { type: "string" },
      examples: { type: "string" },
      name: { type: "string" },
      owner: { type: "string" },
      version: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      "dry-run": { type: "boolean" },
      out: { type: "string" },
    },
  });
  const { version, "dry-run": isDryRun, out, ...settings } = values;
  await publish({ settings: definedOnly(settings), version, isDryRun, out });
}

async function runSearch(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  await search(positionals.join(" "));
}

async function runInfo(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const [spec] = positionals;
  if (spec === undefined || positionals.length > 1) throw new Error("usage: typedhook info owner/name[@range]");
  await info(spec);
}

async function runAdd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { registry: { type: "string" }, lang: { type: "string" } },
  });
  const lang = values.lang === undefined ? undefined : parseLang(values.lang);
  await add(positionals, { registryUrl: values.registry, lang });
}

async function runPull(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { update: { type: "boolean" }, check: { type: "boolean" } },
  });
  await pull(values);
}

async function runSdk(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { lang: { type: "string" }, out: { type: "string" }, package: { type: "string" } },
  });
  const [spec] = positionals;
  if (spec === undefined || positionals.length > 1 || !values.lang || !values.out) {
    throw new Error("usage: typedhook sdk owner/name[@range] --lang <lang> --out <dir>");
  }
  await sdk(spec, { lang: parseLang(values.lang), out: values.out, packageName: values.package });
}

/** parseArgs leaves unset flags as undefined keys, which would overwrite saved settings. */
function definedOnly(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`typedhook: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
// An events module that opened a connection when imported would keep the process
// alive. Unref'd, so a normal run still exits on its own with stdout flushed.
setTimeout(() => process.exit(), 1_000).unref();

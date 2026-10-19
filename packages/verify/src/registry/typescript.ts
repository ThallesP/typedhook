import { componentName } from "./component-ref";
import type { CodegenContext } from "./generate";
import { getDescription, jsDoc, jsonSchemaToTs } from "./json-schema-to-ts";
import { eventKey } from "./model";
import { pascalCase, typeName, uniqueNames } from "./names";

/**
 * An `<Name>EventMap` keyed by what consumers match on, the `<Name>Events`
 * union and `<Name>Event<K>` helper, one alias per component schema (recursive
 * types need a name to point back to) and, when the events carry their name,
 * `create<Name>Webhooks` to verify and route them with @typedhook/verify.
 */
export function typescriptCode({ registry, name, model }: CodegenContext): string {
  const base = typeName(name);
  const mapName = `${base}EventMap`;
  const eventsName = `${base}Events`;
  const eventName = `${base}Event`;
  // Component names are prefixed with the registry's so they can't shadow the
  // built-ins the file uses; the reserved ones stay taken anyway.
  const names = uniqueNames([mapName, eventsName, eventName, "Record"]);
  const aliases = new Map(
    Object.keys(model.schemas)
      .sort()
      .map((key) => [key, names.claim(`${base}${pascalCase(key) || "Schema"}`)]),
  );
  const refName = (ref: string) => {
    const key = componentName(ref);
    return key === null ? undefined : aliases.get(key);
  };

  const members = model.events.map((event) => {
    const type = jsonSchemaToTs(event.payload, { refName, indent: 1 });
    const line = `  ${JSON.stringify(eventKey(model, event))}: ${type};`;
    return event.description === undefined ? line : `${jsDoc(event.description, "  ")}\n${line}`;
  });
  const map = members.length > 0 ? `{\n${members.join("\n")}\n}` : "Record<never, never>";

  const lines = [
    "",
    `export type ${mapName} = ${map};`,
    "",
    `export type ${eventsName} = ${mapName}[keyof ${mapName}];`,
    "",
    `export type ${eventName}<K extends keyof ${mapName}> = ${mapName}[K];`,
  ];
  if (model.discriminator !== null) {
    // The property comes from the document, so it's quoted even in the comment.
    const property = JSON.stringify(model.discriminator.property);
    lines.unshift("", 'import * as typedhook from "@typedhook/verify";');
    lines.push(
      "",
      jsDoc(`Verifies ${registry} webhooks and routes them by ${property}.`, ""),
      `export function create${base}Webhooks(secret: string, options?: typedhook.WebhooksOptions) {`,
      `  return typedhook.createWebhooks<${mapName}>(secret, { ...options, discriminator: ${property} });`,
      "}",
    );
  }
  for (const [key, alias] of aliases) {
    const description = getDescription(model.schemas[key]);
    lines.push("");
    if (description !== null) lines.push(jsDoc(description, ""));
    lines.push(`export type ${alias} = ${jsonSchemaToTs(model.schemas[key], { refName })};`);
  }
  return `${lines.join("\n")}\n`;
}

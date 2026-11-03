import { type RegistryModel, eventKey, typeName } from "@typedhook/verify/registry";

/**
 * A route handler using the generated file: the typed router when the events
 * carry their name, otherwise @typedhook/verify's verifier with the events union.
 */
export function usageCode(model: RegistryModel, registryName: string): string {
  const base = typeName(registryName);
  const modulePath = JSON.stringify(`./webhooks/${registryName}`);
  const [first] = model.events;
  if (model.discriminator === null || first === undefined) {
    return [
      'import { createVerifier } from "@typedhook/verify";',
      `import type { ${base}Events } from ${modulePath};`,
      "",
      "const verifier = createVerifier(process.env.WEBHOOK_SECRET!);",
      "",
      "export async function POST(request: Request) {",
      `  const result = await verifier.verify<${base}Events>(request);`,
      "  if (!result.ok) return new Response(result.reason, { status: 400 });",
      `  // result.payload: ${base}Events`,
      "  return new Response(null, { status: 204 });",
      "}",
    ].join("\n");
  }
  const key = JSON.stringify(eventKey(model, first));
  return [
    `import { create${base}Webhooks } from ${modulePath};`,
    "",
    `const webhooks = create${base}Webhooks(process.env.WEBHOOK_SECRET!);`,
    "",
    "export const POST = webhooks.handler({",
    `  ${key}: async (payload) => {`,
    `    // payload: ${base}Event<${key}>`,
    "  },",
    "});",
  ].join("\n");
}

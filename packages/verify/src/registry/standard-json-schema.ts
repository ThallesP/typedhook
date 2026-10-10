import { isRecord } from "./is-record";

/**
 * Vendored subset of the Standard JSON Schema spec (standardschema.dev).
 * Implemented by zod >= 4.2, ArkType and Valibot.
 */
export interface StandardJSONSchemaV1 {
  readonly "~standard": {
    readonly jsonSchema: {
      readonly output: (options: { readonly target: string }) => Record<string, unknown>;
    };
  };
}

export function isStandardJSONSchema(value: unknown): value is StandardJSONSchemaV1 {
  // ArkType schemas are functions, not plain objects.
  if (typeof value !== "function" && !isRecord(value)) return false;
  const props: unknown = Reflect.get(value, "~standard");
  return (
    isRecord(props) && isRecord(props.jsonSchema) && typeof props.jsonSchema.output === "function"
  );
}

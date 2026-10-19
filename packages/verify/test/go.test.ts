import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createVerifier } from "../src/index";
import { GENERATOR_VERSION, generateCode } from "../src/registry/generate";
import { hashText } from "../src/registry/hash";
import { goPackageName } from "../src/registry/names";
import { toOpenAPI } from "../src/registry/openapi";
import { billingGo } from "./fixtures/go-billing";

const hash = "sha256-3q2+7w/Zm9vYmFy=";
const emptyDocument = { openapi: "3.1.0", info: { title: "x", version: "1.0.0" }, webhooks: {} };
const go = process.env.GO ?? Bun.which("go") ?? "";
// ubuntu-latest has Go, so a missing toolchain fails CI instead of skipping the suite.
const isCI = process.env.CI === "true";
// Caches outside $HOME, kept between runs: the first build of net/http and crypto is the slow part.
const scratch = process.env.TYPEDHOOK_GO_SCRATCH ?? join(tmpdir(), "typedhook-go");

function withComponents(schemas: Record<string, unknown>, webhooks: Record<string, unknown> = {}) {
  return { ...emptyDocument, webhooks, components: { schemas } };
}

function webhook(schema: unknown, summary?: string) {
  return { post: { summary, requestBody: { content: { "application/json": { schema } } } } };
}

function schemaWithJson(json: unknown) {
  return { "~standard": { jsonSchema: { output: () => json } } };
}

function goFile(registry: string, document: unknown): Promise<string> {
  return generateCode("go", { registry, version: "1.0.0", hash, document });
}

function typeNames(text: string): string[] {
  return [...text.matchAll(/^type (\w+)/gm)].flatMap((match) => (match[1] ? [match[1]] : []));
}

// gofmt pads fields into columns; the assertions compare them with single spaces.
function squeeze(text: string): string {
  return text.replace(/ +/g, " ");
}

const hostileText = [
  '*/ func init() { panic("pwned") } /*',
  'func init() { panic("pwned") }',
  "line one\r\nline two\rline three\u2028line four\u0085line five",
  "nul\u0000 bom\uFEFF rlo\u202E lone\uD800 tab\there",
  "''curly'' ``quotes`` ```fence```",
  "# Heading",
  "- item\n  - nested item\n1. numbered",
  "    indented code",
  "[link]: https://example.com",
  "//go:generate rm -rf /",
  "+build ignore",
  "Payment Received\n\nSent when paid.",
].join("\n");

const hostileConsts = ['a"b', "c\\d", "e\nf", "\u0000", "\u2028", "\uD800", "😀", "", "type", "``", "''", "*/", "a\u202Eb"];

const hostilePropertyNames = [
  "a`b",
  'q"r',
  "s\\t",
  "u,v",
  "w\nx",
  "-",
  "",
  " ",
  "a b",
  "__proto__",
  "constructor",
  "é",
  "日本",
  "123",
  "type",
  "func",
  "foo-bar",
  "foo_bar",
  "ID",
  "id",
  "a:b",
];

const hostileNamesDocument = JSON.parse(
  JSON.stringify(
    toOpenAPI(
      Object.fromEntries([
        [
          'x"y\\z',
          schemaWithJson({
            type: "object",
            properties: Object.fromEntries(
              hostilePropertyNames.map((name) => [name, { type: "string", description: hostileText }]),
            ),
            required: ["a b", "-", "__proto__"],
            description: hostileText,
          }),
        ],
        ["line\nbreak", schemaWithJson({ type: "object", properties: { status: { enum: hostileConsts } } })],
        ["__proto__", schemaWithJson({ type: "string" })],
        ["constructor", schemaWithJson({})],
        ["verify", schemaWithJson({ type: "integer" })],
        ["unknown.event", schemaWithJson({ type: "boolean" })],
        ["error", schemaWithJson({ type: "number" })],
        ["Event", schemaWithJson({ type: "string" })],
        ["*/ func init() {}", schemaWithJson({ type: "string" })],
        ["日本.event", schemaWithJson({ type: "string" })],
      ]),
      { title: "x", version: "1.0.0" },
    ),
  ),
);

// Go for hostilenames: escaped event names and enum values decode to what the generated literals say.
const hostileNamesTest = `package hostilenames_test

import (
	"testing"

	"example.com/hooks/hostilenames"
)

func TestParseRoutesEscapedNames(t *testing.T) {
	quoted, ok := parse(t, \`{"event":"x\\"y\\\\z","subject":null,"data":{"a b":"spaced","-":"dash","__proto__":"proto"}}\`).(*hostilenames.XYZ)
	if !ok || quoted.Data.AB != "spaced" || quoted.Data.Field != "dash" || quoted.Data.Proto != "proto" {
		t.Fatalf("got %#v", quoted)
	}
	broken, ok := parse(t, \`{"event":"line\\nbreak","subject":null,"data":{"status":"e\\nf"}}\`).(*hostilenames.LineBreak)
	if !ok || *broken.Data.Status != hostilenames.LineBreakDataStatusEF {
		t.Fatalf("got %#v", broken)
	}
	quote, ok := parse(t, \`{"event":"line\\nbreak","subject":null,"data":{"status":"a\\"b"}}\`).(*hostilenames.LineBreak)
	if !ok || *quote.Data.Status != hostilenames.LineBreakDataStatusAB {
		t.Fatalf("got %#v", quote)
	}
	lone, ok := parse(t, \`{"event":"line\\nbreak","subject":null,"data":{"status":"\\ud800"}}\`).(*hostilenames.LineBreak)
	if !ok || string(*lone.Data.Status) != "\\uFFFD" {
		t.Fatalf("got %#v", lone)
	}
}

func parse(t *testing.T, payload string) hostilenames.Event {
	t.Helper()
	event, err := hostilenames.Parse([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	return event
}
`;

const node = { $ref: "#/components/schemas/node" };

const coverageProperties = {
  count: { type: "integer" },
  ratio: { type: "number" },
  email: { type: "string", format: "email" },
  isActive: { type: "boolean" },
  nickname: { type: ["string", "null"] },
  repeated: { type: ["string", "string", "null", "null"] },
  either: { type: ["string", "integer"] },
  reason: { anyOf: [{ type: "string", enum: ["duplicate", "fraudulent"] }, { type: "null" }] },
  priority: { enum: [1, 2, 3] },
  weight: { enum: [1, 2.5] },
  flag: { const: true },
  kind: { anyOf: [{ const: "a" }, { const: "b" }, { type: "null" }] },
  mixed: { oneOf: [{ type: "string" }, { type: "integer" }] },
  sameScalar: { anyOf: [{ type: "string", format: "uuid" }, { type: "string", maxLength: 3 }] },
  merged: { allOf: [node, { properties: { label: { type: "string" } }, required: ["label"] }] },
  constrained: { allOf: [{ type: "string" }, { minLength: 1 }] },
  oneRef: { allOf: [{ $ref: "#/components/schemas/tags" }], description: "only a ref" },
  atLeastOne: { type: "object", properties: { a: { type: "string" } }, anyOf: [{ required: ["a"] }, { required: ["b"] }] },
  labels: { type: "object", additionalProperties: { type: "string" } },
  nodesById: { type: "object", additionalProperties: node },
  free: { type: "object" },
  anything: {},
  closed: { type: "object", additionalProperties: false },
  pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
  point: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], items: false },
  rows: { type: "array", items: { type: "object", properties: { cells: { type: "array", items: { type: ["number", "null"] } } } } },
  untyped: { type: "array" },
  never: false,
  always: true,
  date: { type: "date" },
  nothing: { type: "null" },
  ref: node,
  optionalRef: node,
  maybeRef: { $ref: "#/components/schemas/maybe" },
  statusRef: { $ref: "#/components/schemas/status" },
  tagsRef: { $ref: "#/components/schemas/tags" },
  missingRef: { $ref: "#/components/schemas/missing" },
  protoRef: { $ref: "#/components/schemas/__proto__" },
  nestedRef: { $ref: "#/components/schemas/node/properties/next" },
  loopRef: { $ref: "#/components/schemas/loop1" },
};

// No discriminator: GitHub-style events named only by the webhook.
const hostileSchemasDocument = withComponents(
  {
    verify: { type: "object", properties: { id: { type: "string" } }, description: hostileText },
    Event: { type: "string", description: hostileText },
    error: { type: "integer" },
    "reason-invalid-id": { type: "boolean" },
    UnknownEvent: { type: "object", additionalProperties: false },
    "default-tolerance": { type: "number" },
    loop1: { $ref: "#/components/schemas/loop2" },
    loop2: { $ref: "#/components/schemas/loop1" },
    self: { $ref: "#/components/schemas/self" },
    "a-b": { type: "array", items: { $ref: "#/components/schemas/a_b" } },
    a_b: { $ref: "#/components/schemas/a-b" },
    node: {
      type: "object",
      properties: { next: node, children: { type: "array", items: node } },
      required: ["next", "children"],
    },
    pairA: { type: "object", properties: { b: { $ref: "#/components/schemas/pairB" } }, required: ["b"] },
    pairB: {
      type: "object",
      properties: {
        a: { $ref: "#/components/schemas/pairA" },
        inline: { type: "object", properties: { back: { $ref: "#/components/schemas/pairB" } }, required: ["back"] },
      },
      required: ["a", "inline"],
    },
    maybe: { anyOf: [node, { type: "null" }] },
    status: { enum: ["active", "past_due", null] },
    tags: { type: "array", items: { type: "string" } },
    selfAllOf: { allOf: [{ $ref: "#/components/schemas/selfAllOf" }, { properties: { x: { type: "string" } } }] },
    everything: {
      type: "object",
      properties: coverageProperties,
      required: Object.keys(coverageProperties).filter((key) => key !== "optionalRef"),
    },
  },
  {
    push: webhook({ $ref: "#/components/schemas/everything" }, hostileText),
    ping: webhook({ type: "string" }),
    raw: webhook(true),
    list: webhook({ type: "array", items: node }),
    maybe: webhook({ $ref: "#/components/schemas/maybe" }),
  },
);

// Stripe-style: the events share a base schema and name themselves in `type`.
const stripeLikeDocument = withComponents(
  {
    Base: {
      type: "object",
      properties: { id: { type: "string" }, type: { type: "string" }, created: { type: "integer" } },
      required: ["id", "type", "created"],
    },
    Invoice: {
      type: "object",
      properties: { id: { type: "string" }, amount_due: { type: "integer" }, hosted_invoice_url: { type: "string" } },
      required: ["id"],
    },
  },
  {
    "invoice.paid": webhook(
      {
        allOf: [
          { $ref: "#/components/schemas/Base" },
          {
            properties: {
              type: { const: "invoice.paid" },
              data: {
                type: "object",
                properties: { object: { $ref: "#/components/schemas/Invoice" } },
                required: ["object"],
              },
            },
          },
        ],
      },
      "Occurs whenever an invoice payment attempt succeeds.",
    ),
    Verify: webhook({ allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { type: { const: "verify" } } }] }),
  },
);

const plainDocument = withComponents({}, { "user.created": webhook({ type: "object", properties: { id: { type: "string" } } }) });

const compiledDocuments = [
  { name: "hostile-names", document: hostileNamesDocument },
  { name: "hostile-schemas", document: hostileSchemasDocument },
  { name: "go", document: stripeLikeDocument },
  { name: "1password", document: plainDocument },
  { name: "empty", document: emptyDocument },
];

type SignedCase = {
  name: string;
  body: string;
  headers: Record<string, string>;
  secret: string;
  toleranceSeconds: number;
  reason: string;
};

const signingKey = Buffer.from("typedhook-go-test-signing-key-32");
const secret = `whsec_${signingKey.toString("base64")}`;
const paidBody = JSON.stringify({
  event: "invoice.paid",
  subject: null,
  data: { invoiceId: "in_1", amountCents: 4200, paidAt: "2026-01-01T00:00:00Z", lines: [] },
});

function signature(key: Buffer, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

type Delivery = { id?: string; timestamp?: number; body?: string; key?: Buffer; prefix?: string };

function headers({ id = "msg_1", timestamp = now(), body = paidBody, key = signingKey, prefix = "webhook" }: Delivery) {
  return {
    [`${prefix}-id`]: id,
    [`${prefix}-timestamp`]: String(timestamp),
    [`${prefix}-signature`]: signature(key, id, timestamp, body),
  };
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Deliveries signed here and verified by the generated Go. Fresh ones get a
 * day of tolerance so a slow first `go test` build can't age them; the
 * default 5 minutes is tested with timestamps an hour off.
 */
function signedCases(): SignedCase[] {
  const day = 86_400;
  const valid = { body: paidBody, secret, toleranceSeconds: day };
  const timestamp = now();
  const good = headers({ timestamp });
  const goodSignature = signature(signingKey, "msg_1", timestamp, paidBody);
  const bad = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  // A 32-byte MAC leaves 2 unused bits in its last base64 digit; setting one keeps the bytes.
  const digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lastDigit = digits.indexOf(goodSignature.charAt(goodSignature.length - 2));
  const padded = `${goodSignature.slice(0, -2)}${digits.charAt(lastDigit ^ 1)}=`;
  return [
    { ...valid, name: "whsec_ secret", headers: good, reason: "" },
    {
      ...valid,
      name: "raw secret",
      secret: "raw-secret",
      headers: headers({ key: Buffer.from("raw-secret") }),
      reason: "",
    },
    { ...valid, name: "svix headers", headers: headers({ prefix: "svix" }), reason: "" },
    { ...valid, name: "uppercase header names", headers: { "WEBHOOK-ID": "msg_1", ...good }, reason: "" },
    { ...valid, name: "tampered body", body: paidBody.replace("4200", "1"), headers: good, reason: "invalid_signature" },
    {
      ...valid,
      name: "stale timestamp",
      toleranceSeconds: 0,
      headers: headers({ timestamp: now() - 3600 }),
      reason: "timestamp_out_of_tolerance",
    },
    {
      ...valid,
      name: "future timestamp",
      toleranceSeconds: 0,
      headers: headers({ timestamp: now() + 3600 }),
      reason: "timestamp_out_of_tolerance",
    },
    { ...valid, name: "an hour old within a day", headers: headers({ timestamp: now() - 3600 }), reason: "" },
    { ...valid, name: "dotted id", headers: headers({ id: "msg.1" }), reason: "invalid_id" },
    { ...valid, name: "invalid whsec_ secret", secret: "whsec_!!!!", headers: good, reason: "invalid_secret" },
    { ...valid, name: "empty whsec_ secret", secret: "whsec_", headers: good, reason: "invalid_secret" },
    {
      ...valid,
      name: "whsec_ secret with a newline",
      secret: `${secret.slice(0, 12)}\n${secret.slice(12)}`,
      headers: good,
      reason: "invalid_secret",
    },
    { ...valid, name: "empty secret", secret: "", headers: good, reason: "invalid_secret" },
    { ...valid, name: "missing headers", headers: {}, reason: "missing_headers" },
    {
      ...valid,
      name: "empty webhook-id doesn't fall back to svix-id",
      headers: { ...headers({ prefix: "svix" }), "webhook-id": "" },
      reason: "missing_headers",
    },
    {
      ...valid,
      name: "non-integer timestamp",
      headers: { ...good, "webhook-timestamp": "12.5" },
      reason: "invalid_timestamp",
    },
    {
      ...valid,
      name: "signed timestamp with a plus sign",
      headers: { ...good, "webhook-timestamp": `+${timestamp}` },
      reason: "",
    },
    {
      ...valid,
      name: "the right signature among others",
      headers: { ...good, "webhook-signature": `v2,abc ${bad} v1, ${goodSignature}` },
      reason: "",
    },
    {
      ...valid,
      name: "the right signature after eight v1 candidates",
      headers: { ...good, "webhook-signature": [...Array(8).fill(bad), goodSignature].join(" ") },
      reason: "invalid_signature",
    },
    {
      ...valid,
      name: "other versions don't count as candidates",
      headers: { ...good, "webhook-signature": [...Array(9).fill("v2,abc"), goodSignature].join(" ") },
      reason: "",
    },
    {
      ...valid,
      name: "a third comma-separated part is ignored",
      headers: { ...good, "webhook-signature": `${goodSignature},extra` },
      reason: "",
    },
    {
      ...valid,
      name: "unused base64 bits set",
      headers: { ...good, "webhook-signature": padded },
      reason: "",
    },
    {
      ...valid,
      name: "invalid JSON",
      body: "not json",
      headers: headers({ body: "not json" }),
      reason: "invalid_json",
    },
  ];
}

async function typescriptReason({ body, headers, secret, toleranceSeconds }: SignedCase): Promise<string> {
  const options = toleranceSeconds === 0 ? {} : { toleranceSec: toleranceSeconds };
  try {
    const result = await createVerifier(secret, options).verifyPayload(body, headers);
    return result.ok ? "" : result.reason;
  } catch (error) {
    if (error instanceof RangeError) return "invalid_secret";
    throw error;
  }
}

function goEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(scratch, "home"),
    GOCACHE: join(scratch, "cache"),
    GOPATH: join(scratch, "path"),
    GOENV: "off",
    GOFLAGS: "-p=2",
    GOPROXY: "off",
    GOTOOLCHAIN: "local",
    CGO_ENABLED: "0",
    ...extra,
  };
}

function run(cmd: string[], cwd: string, env: Record<string, string> = {}): { exitCode: number; output: string } {
  const { exitCode, stdout, stderr } = Bun.spawnSync({ cmd, cwd, env: goEnv(env), stdout: "pipe", stderr: "pipe" });
  return { exitCode, output: `${stdout.toString()}${stderr.toString()}` };
}

describe("generateCode go", () => {
  test("writes the header, the package and a struct per event and object", async () => {
    const document = toOpenAPI(
      { "user.created": z.object({ userId: z.string(), nickname: z.string().nullable() }) },
      { title: "Accounts", version: "2.1.0" },
    );
    const text = await generateCode("go", { registry: "acme/user-accounts", version: "2.1.0", hash, document });
    const body = text.slice(text.indexOf("\n") + 1);
    const source = `acme/user-accounts@2.1.0 (doc ${hash}, body ${await hashText(body)})`;
    expect(text).toStartWith(
      [
        `// Code generated by typedhook pull v${GENERATOR_VERSION} from ${source}. DO NOT EDIT.`,
        "",
        "// Package useraccounts holds the acme/user-accounts webhook events and verifies their Standard Webhooks signatures.",
        "package useraccounts",
        "",
      ].join("\n"),
    );
    expect(text).toEndWith(
      [
        "",
        '// UserCreated is the "user.created" event.',
        "type UserCreated struct {",
        "\tEvent   string          `json:\"event\"`",
        "\tSubject *string         `json:\"subject\"`",
        "\tData    UserCreatedData `json:\"data\"`",
        "}",
        "",
        "func (*UserCreated) isEvent() {}",
        "",
        "type UserCreatedData struct {",
        "\tUserID   string  `json:\"userId\"`",
        "\tNickname *string `json:\"nickname\"`",
        "}",
        "",
      ].join("\n"),
    );
    expect(text).toContain('\tswitch name {\n\tcase "user.created":\n\t\tevent = &UserCreated{}\n\tdefault:');
    expect(text).toContain('\tif err := json.Unmarshal(fields["event"], &name); err != nil {');
    expect(text).toContain("func Verify(payload []byte, header http.Header, secret string) (Event, error) {");
    expect(text).toContain('\t\treturn "useraccounts: " + string(e.Reason)');
  });

  test("without a discriminator there's only signature verification", async () => {
    const text = await goFile("acme/1password", plainDocument);
    expect(text).toContain("package x1password\n");
    expect(text).toContain("func VerifySignature(payload []byte, header http.Header, secret string) error {");
    expect(text).toContain('type UserCreated struct {\n\tID *string `json:"id,omitempty"`\n}');
    expect(text).not.toContain("func Parse(");
    expect(text).not.toContain("type Event interface");
    expect(text).not.toContain("func Verify(");
    expect(text).not.toContain('"encoding/json"');
  });

  test("an empty webhooks object gives the verifier alone", async () => {
    const text = await goFile("acme/empty", emptyDocument);
    expect(typeNames(text)).toEqual(["Verifier", "Reason", "Error"]);
  });

  test("types don't repeat the package name, and a recursive event's data is named after it", async () => {
    const text = await billingGo();
    expect(text).toContain("package billing\n");
    expect(typeNames(text)).toContain("InvoicePaid");
    expect(text).not.toContain("BillingInvoicePaid");
    expect(squeeze(text)).toContain('\tData CategoryCreatedData `json:"data"`');
    expect(squeeze(text)).toContain('\tParent *CategoryCreatedData `json:"parent,omitempty"`');
  });

  test("keeps type names unique and off the runtime's identifiers", async () => {
    const text = await goFile(
      "acme/polar",
      withComponents({
        verify: { type: "string" },
        Event: { type: "string" },
        error: { type: "string" },
        "reason-invalid-id": { type: "string" },
        unknown_event: { type: "string" },
        "foo-bar": { type: "string" },
        foo_bar: { type: "number" },
        $: { type: "string" },
        "é": { type: "string" },
        "--": { type: "string" },
        "1st": { type: "string" },
        "user-id": { type: "string" },
      }),
    );
    expect(typeNames(text)).toEqual([
      "Verifier",
      "Reason",
      "Error",
      "Schema",
      "Schema2",
      "X1st",
      "Event2",
      "Error2",
      "FooBar",
      "FooBar2",
      "ReasonInvalidID2",
      "UnknownEvent2",
      "UserID",
      "Verify2",
      "Schema3",
    ]);
    expect(text).toContain("type FooBar2 = float64");
  });

  test("refs point at the renamed types, unknown refs are raw JSON, and ref loops are broken", async () => {
    const text = await goFile(
      "acme/shop",
      withComponents({
        "a-b": { type: "array", items: { $ref: "#/components/schemas/a_b" } },
        a_b: { $ref: "#/components/schemas/a-b" },
        other: { $ref: "#/components/schemas/__proto__" },
        loop1: { $ref: "#/components/schemas/loop2" },
        loop2: { $ref: "#/components/schemas/loop1" },
        self: { $ref: "#/components/schemas/self" },
        "a/b": { type: "string" },
        "c~d": { type: "number" },
        escaped: {
          type: "object",
          properties: {
            slash: { $ref: "#/components/schemas/a~1b" },
            tilde: { $ref: "#/components/schemas/c~0d" },
            inside: { $ref: "#/components/schemas/a~1b/items" },
          },
          required: ["slash", "tilde", "inside"],
        },
      }),
    );
    expect(text).toContain("type AB []AB3");
    expect(text).toContain("type AB3 = AB");
    expect(text).toContain("type Other = json.RawMessage");
    expect(text).toContain("type Loop1 = json.RawMessage");
    expect(text).toContain("type Loop2 = json.RawMessage");
    expect(text).toContain("type Self = json.RawMessage");
    expect(squeeze(text)).toContain(
      'type Escaped struct {\n\tSlash AB2 `json:"slash"`\n\tTilde CD `json:"tilde"`\n\tInside json.RawMessage `json:"inside"`\n}',
    );
  });

  test("component structs reach other structs through pointers, event structs hold them by value", async () => {
    const text = squeeze(await goFile("acme/shop", hostileSchemasDocument));
    expect(text).toContain('type Node struct {\n\tNext *Node `json:"next"`\n\tChildren []Node `json:"children"`\n}');
    expect(text).toContain('type PairA struct {\n\tB *PairB `json:"b"`\n}');
    expect(text).toContain('type PairBInline struct {\n\tBack *PairB `json:"back"`\n}');
    expect(text).toContain('\tRef *Node `json:"ref"`');
    expect(text).toContain('\tMaybeRef *MaybeData `json:"maybeRef"`');
    expect(squeeze(await goFile("acme/go", stripeLikeDocument))).toContain(
      'type InvoicePaidData struct {\n\tObject Invoice `json:"object"`\n}',
    );
  });

  test("without a discriminator, events are their payload's type", async () => {
    const text = await goFile("acme/shop", hostileSchemasDocument);
    expect(text).toContain("type Push = Everything");
    expect(text).toContain("type List []Node");
    expect(text).toContain("type Maybe = MaybeData");
    expect(text).toContain("type Ping = string");
    expect(text).toContain("type Raw = json.RawMessage");
  });

  test("declares an object repeated across schemas once", async () => {
    // Like GitHub's document, where every event's schema spells out the same repository object.
    const repository = {
      type: "object",
      properties: {
        id: { type: "integer" },
        owner: { type: "object", properties: { login: { type: "string" } }, required: ["login"] },
        visibility: { enum: ["public", "private"] },
      },
      required: ["id", "owner"],
    };
    const names = Array.from({ length: 200 }, (_, index) => `event-${index}`);
    const schemas = names.map((name) => [
      `webhook-${name}`,
      { type: "object", properties: { action: { type: "string" }, repository: structuredClone(repository) } },
    ]);
    const webhooks = names.map((name) => [name, webhook({ $ref: `#/components/schemas/webhook-${name}` })]);
    const text = await goFile("acme/github", withComponents(Object.fromEntries(schemas), Object.fromEntries(webhooks)));
    expect(typeNames(text).filter((name) => /Repository|Owner|Visibility/.test(name))).toEqual([
      "WebhookEvent0Repository",
      "WebhookEvent0RepositoryOwner",
      "WebhookEvent0RepositoryVisibility",
    ]);
    expect(squeeze(text)).toContain('\tRepository *WebhookEvent0Repository `json:"repository,omitempty"`');
    expect(text).toContain("type Event199 = WebhookEvent199");
  });

  test("maps JSON Schema to Go types", async () => {
    const text = squeeze(await goFile("acme/shop", hostileSchemasDocument));
    const expected = [
      'Count int64 `json:"count"`',
      'Ratio float64 `json:"ratio"`',
      'Email string `json:"email"`',
      'IsActive bool `json:"isActive"`',
      'Nickname *string `json:"nickname"`',
      'Repeated *string `json:"repeated"`',
      'Either json.RawMessage `json:"either"`',
      'Reason *EverythingReason `json:"reason"`',
      'Priority int64 `json:"priority"`',
      'Weight float64 `json:"weight"`',
      'Flag bool `json:"flag"`',
      'Kind *EverythingKind `json:"kind"`',
      'Mixed json.RawMessage `json:"mixed"`',
      'SameScalar string `json:"sameScalar"`',
      'Merged EverythingMerged `json:"merged"`',
      'Constrained string `json:"constrained"`',
      '\t// only a ref\n\tOneRef Tags `json:"oneRef"`',
      'AtLeastOne EverythingAtLeastOne `json:"atLeastOne"`',
      'Labels map[string]string `json:"labels"`',
      'NodesByID map[string]Node `json:"nodesById"`',
      'Free map[string]any `json:"free"`',
      'Anything json.RawMessage `json:"anything"`',
      'Closed struct{} `json:"closed"`',
      'Pair []json.RawMessage `json:"pair"`',
      'Point []float64 `json:"point"`',
      'Rows []EverythingRowsItem `json:"rows"`',
      'Untyped []json.RawMessage `json:"untyped"`',
      'Never json.RawMessage `json:"never"`',
      'Always json.RawMessage `json:"always"`',
      'Date json.RawMessage `json:"date"`',
      'Nothing json.RawMessage `json:"nothing"`',
      'OptionalRef *Node `json:"optionalRef,omitempty"`',
      'StatusRef *Status `json:"statusRef"`',
      'TagsRef Tags `json:"tagsRef"`',
      'MissingRef json.RawMessage `json:"missingRef"`',
      'ProtoRef json.RawMessage `json:"protoRef"`',
      'NestedRef json.RawMessage `json:"nestedRef"`',
      'LoopRef Loop1 `json:"loopRef"`',
      'type EverythingMerged struct {\n\tNext *Node `json:"next"`\n\tChildren []Node `json:"children"`\n\tLabel string `json:"label"`\n}',
      'type EverythingAtLeastOne struct {\n\tA *string `json:"a,omitempty"`\n}',
      'type EverythingRowsItem struct {\n\tCells []*float64 `json:"cells,omitempty"`\n}',
      'const (\n\tEverythingKindA EverythingKind = "a"\n\tEverythingKindB EverythingKind = "b"\n)',
      'const (\n\tStatusActive Status = "active"\n\tStatusPastDue Status = "past_due"\n)',
      "type Tags []string",
      "type Ping = string",
      "type Raw = json.RawMessage",
      "type UnknownEvent2 struct{}",
      'type SelfAllOf struct {\n\tX *string `json:"x,omitempty"`\n}',
    ];
    for (const line of expected) expect(text).toContain(line);
  });

  test("merges allOf parts and finds the discriminator through them", async () => {
    const text = await goFile("acme/go", stripeLikeDocument);
    expect(text).toContain("package xgo\n");
    expect(squeeze(text)).toContain(
      'type InvoicePaid struct {\n\tID string `json:"id"`\n\tType string `json:"type"`\n\tCreated int64 `json:"created"`\n\tData *InvoicePaidData `json:"data,omitempty"`\n}',
    );
    expect(squeeze(text)).toContain('\tHostedInvoiceURL *string `json:"hosted_invoice_url,omitempty"`');
    expect(text).toContain("// InvoicePaid is the \"invoice.paid\" event.\n// Occurs whenever an invoice payment attempt succeeds.\n");
    expect(text).toContain('\tcase "verify":\n\t\tevent = &Verify2{}');
    expect(text).toContain('fields["type"]');
  });

  test("untrusted names, descriptions and constants stay inside comments and string literals", async () => {
    const texts = await Promise.all([
      goFile("acme/hostile-names", hostileNamesDocument),
      goFile("acme/hostile-schemas", hostileSchemasDocument),
    ]);
    for (const text of texts) {
      const code = text
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line))
        .map((line) => line.replace(/"(?:[^"\\]|\\.)*"/g, '""'));
      expect(code.filter((line) => line.includes("panic") || line.includes("func init"))).toEqual([]);
      expect(text).not.toMatch(/^\s*\/\/\s*\+build/m);
      expect(text).not.toMatch(/[\u0000\uFEFF\u202E\u2028\u0085\r]/);
      expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
      const comments = text.split("\n").filter((line) => /^\s*\/\//.test(line));
      expect(comments.filter((line) => line.includes("''"))).toEqual([]);
    }
    const [names] = texts;
    for (const skipped of ["a`b", 'q"r', "s\\t", "u,v", "w\nx", 'json:""']) expect(names).not.toContain(skipped);
    expect(squeeze(names)).toContain('\tField string `json:"-,"`');
    expect(squeeze(names)).toContain('\tField2 *string `json:" ,omitempty"`');
    expect(squeeze(names)).toContain('\tAB string `json:"a b"`');
    expect(squeeze(names)).toContain('\tProto string `json:"__proto__"`');
    expect(squeeze(names)).toContain('\tField4 *string `json:"日本,omitempty"`');
    expect(squeeze(names)).toContain('\tID2 *string `json:"id,omitempty"`');
    expect(names).toContain('\tcase "x\\"y\\\\z":\n\t\tevent = &XYZ{}');
    expect(names).toContain('\tcase "line\\nbreak":\n\t\tevent = &LineBreak{}');
    expect(names).toContain('\tcase "\\u65e5\\u672c.event":\n\t\tevent = &Event3{}');
    expect(names).toContain('// FuncInit is the "*/ func init() {}" event.');
    for (const literal of ['"a\\"b"', '"c\\\\d"', '"e\\nf"', '"\\u0000"', '"\\u2028"', '"\\uFFFD"', '"\\U0001f600"']) {
      expect(names).toContain(` LineBreakDataStatus = ${literal}\n`);
    }
  });

  test("names thousands of colliding components quickly", async () => {
    // 12,000 keys that all become "X".
    const schemas = Object.fromEntries(
      Array.from({ length: 12_000 }, (_, index) => [
        `${"-".repeat(index % 110)}x${"-".repeat(Math.floor(index / 110))}`,
        { type: "string" },
      ]),
    );
    const startedAt = performance.now();
    const text = await goFile("acme/shop", withComponents(schemas));
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(text).toContain("type X = string");
    expect(text).toContain("type X12000 = string");
  });

  test("refuses output past the size cap, including schemas that inline each other", async () => {
    const big = withComponents({ big: { enum: ["x".repeat(5_000_001), "y"] } });
    await expect(goFile("acme/x", big)).rejects.toThrow("over 5,000,000 characters");
    // Each schema copies every property before it: quadratic output from a linear document.
    const chain = Object.fromEntries(
      Array.from({ length: 4_000 }, (_, index) => [
        `s${index}`,
        {
          allOf: [
            ...(index === 0 ? [] : [{ $ref: `#/components/schemas/s${index - 1}` }]),
            { properties: { [`property${index}`]: { type: "string" } } },
          ],
        },
      ]),
    );
    await expect(goFile("acme/x", withComponents(chain))).rejects.toThrow("over 5,000,000 characters");
  });

  test("the committed Go billing fixture matches the generator", async () => {
    const committed = await Bun.file(new URL("./fixtures/go/billing/billing.go", import.meta.url)).text();
    // On failure, regenerate with `bun packages/verify/test/fixtures/go-billing.ts` and review the diff.
    expect(await billingGo()).toBe(committed);
  });

  test("the signed cases get the reasons @typedhook/verify gives", async () => {
    for (const signedCase of signedCases()) {
      expect({ name: signedCase.name, reason: await typescriptReason(signedCase) }).toEqual({
        name: signedCase.name,
        reason: signedCase.reason,
      });
    }
  });
});

describe.skipIf(!isCI && go === "")("generated Go, built with the go toolchain", () => {
  test(
    "is gofmt-clean, passes go vet, and verifies and decodes like @typedhook/verify",
    async () => {
      await mkdir(scratch, { recursive: true });
      const module = await mkdtemp(join(scratch, "module-"));
      try {
        await cp(join(import.meta.dir, "fixtures", "go"), module, { recursive: true });
        await writeFile(join(module, "billing", "billing.go"), await billingGo());
        for (const { name, document } of compiledDocuments) {
          const pkg = goPackageName(name);
          await mkdir(join(module, pkg));
          await writeFile(join(module, pkg, `${pkg}.go`), await goFile(`acme/${name}`, document));
        }
        await writeFile(join(module, "hostilenames", "hostilenames_test.go"), hostileNamesTest);
        const casesPath = join(module, "cases.json");
        await writeFile(casesPath, JSON.stringify(signedCases()));
        const goroot = run([go, "env", "GOROOT"], module).output.trim();

        expect(run([join(goroot, "bin", "gofmt"), "-l", "."], module)).toEqual({ exitCode: 0, output: "" });
        expect(run([go, "vet", "./..."], module)).toEqual({ exitCode: 0, output: "" });
        const tested = run([go, "test", "-count=1", "./..."], module, { TYPEDHOOK_CASES: casesPath });
        expect(tested.output).toContain("ok  \texample.com/hooks/billing");
        expect(tested.output).toContain("ok  \texample.com/hooks/hostilenames");
        expect(tested.exitCode).toBe(0);
      } finally {
        await rm(module, { recursive: true, force: true });
      }
    },
    600_000,
  );
});

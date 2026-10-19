import { describe, expect, test } from "bun:test";
import { billingDocument } from "../../verify/test/fixtures/billing";
import {
  type RegistrySummary,
  type VersionSummary,
  homePage,
  notFoundPage,
  registryPage,
} from "../src/pages/render";

const EVIL = `<script>alert(1)</script>"><img src=x onerror=alert(1)></style>javascript:alert(1)'`;

const ESCAPED_SCRIPT = "&lt;script&gt;alert(1)&lt;/script&gt;";

const ALLOWED_TAGS = new Set([
  "!doctype",
  "html",
  "head",
  "meta",
  "title",
  "link",
  "style",
  "body",
  "div",
  "header",
  "nav",
  "main",
  "footer",
  "section",
  "article",
  "aside",
  "details",
  "summary",
  "form",
  "label",
  "input",
  "button",
  "h1",
  "h2",
  "h3",
  "p",
  "a",
  "span",
  "strong",
  "br",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "svg",
  "rect",
  "g",
  "circle",
  "path",
]);

const billing: RegistrySummary = {
  owner: "acme",
  name: "billing",
  title: "Acme Billing",
  description: "Invoices, customers and usage records.",
  latest: "1.1.0",
  updatedAt: "2026-10-19 03:12:44",
};

const billingVersions: VersionSummary[] = [
  {
    version: "1.1.0",
    createdAt: "2026-10-19 03:12:44",
    bump: "minor",
    publishedBy: "acme/billing-service (GitHub Actions)",
    changes: [
      { bump: "minor", event: "usage.recorded", path: "", message: "added" },
      { bump: "minor", event: "customer.updated", path: "data.email", message: "was added (optional)" },
    ],
  },
  { version: "1.0.0", createdAt: "2026-10-12 18:40:02", bump: null, changes: null, publishedBy: "thallesp" },
];

/**
 * Every tag in the page is one the templates write, with no event handler
 * attributes and no link that leaves for anything but a path, an anchor or https.
 */
function expectNoLiveMarkup(page: string): void {
  for (const [tag] of page.matchAll(/<[^>]*>/g)) {
    const name = /^<\/?([!a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase() ?? tag;
    expect(ALLOWED_TAGS.has(name) ? name : `unexpected tag ${tag}`).toBe(name);
    for (const [, attribute = "", value = ""] of tag.matchAll(/\s([^\s="'>/]+)(?:="([^"]*)")?/g)) {
      expect(attribute.toLowerCase().startsWith("on") ? `handler in ${tag}` : attribute).toBe(attribute);
      if (attribute === "href") expect(isSafeHref(value) ? value : `unsafe href in ${tag}`).toBe(value);
      if (attribute === "id") expect(value).toMatch(/^[a-z0-9._:-]+$/);
    }
  }
  expect(page.match(/<\/style>/g)).toHaveLength(1);
  expect(page.toLowerCase()).not.toContain("<script");
  expect(page.toLowerCase()).not.toContain("<img");
}

/** The page without tags, entities decoded: what highlighted code reads as. */
function textOf(page: string): string {
  return page
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function isSafeHref(href: string): boolean {
  const decoded = href.replaceAll("&amp;", "&");
  return (
    /^\/(?!\/)[^:]*$/.test(decoded) ||
    /^#[a-z0-9._-]+$/.test(decoded) ||
    decoded.startsWith("https://") ||
    decoded.startsWith("data:image/svg+xml,")
  );
}

describe("homePage", () => {
  test("says there are no registries yet and how to publish one", () => {
    const page = homePage({ registries: [], query: "" });
    expect(page).toContain("No registries yet");
    expect(page).not.toContain('class="registry-list"');
    expect(page).toContain("npx typedhook login");
    expect(page).toContain("npx typedhook publish");
    expect(page).toContain("npx skills add ThallesP/typedhook");
    expect(page).toContain("claude mcp add --transport http typedhook https://registry.typedhook.dev/mcp");
    expectNoLiveMarkup(page);
  });

  test("lists registries in the order given, linking to each", () => {
    const other = { ...billing, owner: "northwind", name: "orders", title: "Northwind Orders", description: null };
    const page = homePage({ registries: [billing, other], query: "" });
    expect(page).toContain('href="/acme/billing"');
    expect(page).toContain('href="/northwind/orders"');
    expect(page.indexOf("/acme/billing")).toBeLessThan(page.indexOf("/northwind/orders"));
    expect(page).toContain("Acme Billing");
    expect(page).toContain("Oct 19, 2026");
    expect(page).toContain("2 registries");
    expectNoLiveMarkup(page);
  });

  test("keeps the query in the search box and says when nothing matches", () => {
    const results = homePage({ registries: [billing], query: "billing" });
    expect(results).toContain('name="q" value="billing"');
    expect(results).toContain("Results for “billing”");

    const empty = homePage({ registries: [], query: "stripe" });
    expect(empty).toContain("Nothing matches “stripe”");
    expect(empty).toContain('href="/"');
  });
});

describe("registryPage", () => {
  test("shows install commands, usage, events, generated code and versions", async () => {
    const page = await registryPage({
      summary: billing,
      versions: billingVersions,
      version: "1.1.0",
      document: billingDocument,
    });
    expect(page).toContain("<title>acme/billing · typedhook registry</title>");
    expect(page).toContain("npx typedhook add acme/billing</span>");
    expect(page).toContain("createBillingWebhooks");
    for (const event of ["category.created", "customer.updated", "invoice.paid", "invoice.voided", "usage.recorded"]) {
      expect(page).toContain(`id="${event}"`);
      expect(page).toContain(`href="#${event}"`);
    }
    expect(textOf(page)).toContain("type BillingCategoryCreated = {");
    expect(page).toContain("Generated code");
    expect(page).toContain('<span class="badge badge-minor">minor</span>');
    expect(page).toContain("was added (optional)");
    expect(page).toContain("by acme/billing-service (GitHub Actions)");
    expect(page).toContain("First version");
    expect(page).not.toContain("You're viewing");
    expectNoLiveMarkup(page);
  });

  test("shows each event's example, or its data's example in the typedhook envelope", async () => {
    const page = await registryPage({
      summary: { ...billing, name: "orders" },
      versions: billingVersions,
      version: "1.1.0",
      document: {
        openapi: "3.1.0",
        info: { title: "Orders", version: "1.1.0" },
        webhooks: {
          "order.paid": jsonWebhook({
            type: "object",
            properties: { type: { const: "order.paid" }, orderId: { type: "string" } },
            examples: [{ type: "order.paid", orderId: "ord_paid_42" }],
          }),
          "order.shipped": jsonWebhook({
            type: "object",
            properties: {
              type: { const: "order.shipped" },
              data: { type: "object", examples: [{ trackingId: "trk_shipped_42" }] },
            },
          }),
        },
      },
    });
    expect(page).toContain(">Example</label>");
    expect(page).toContain("ord_paid_42");
    expect(page).toContain(">Example data</label>");
    expect(page).toContain("trk_shipped_42");
  });

  test("points an older version at the latest one", async () => {
    const page = await registryPage({
      summary: billing,
      versions: billingVersions,
      version: "1.0.0",
      document: billingDocument,
    });
    expect(page).toContain("You're viewing 1.0.0");
    expect(page).toContain('href="/acme/billing">1.1.0</a>');
    expect(page).toContain('href="/acme/billing?version=1.0.0"');
  });

  test("still renders when the document can't be read or code can't be generated", async () => {
    const unreadable = await registryPage({
      summary: billing,
      versions: billingVersions,
      version: "1.1.0",
      document: { openapi: "3.1.0", webhooks: { "order.paid": {} } },
    });
    expect(unreadable).toContain("can't be read");
    expect(unreadable).toContain("Versions");

    const ungenerated = await registryPage({
      summary: billing,
      versions: billingVersions,
      version: "not a version",
      document: billingDocument,
    });
    expect(ungenerated).toContain('id="invoice.paid"');
    expect(ungenerated).not.toContain('id="install"');
    expect(ungenerated).not.toContain('id="code"');
  });
});

describe("hostile input", () => {
  const hostileDocument = {
    openapi: "3.1.0",
    info: { title: EVIL, version: "1.0.0", description: EVIL },
    webhooks: {
      [EVIL]: hostileWebhook(EVIL),
      "javascript:alert(1)": hostileWebhook("javascript:alert(1)"),
    },
    components: {
      schemas: {
        [EVIL]: { type: "object", description: EVIL, properties: { [EVIL]: { $ref: "#/components/schemas/x" } } },
      },
    },
  };

  test("the registry page escapes titles, descriptions, event and property names, examples and changes", async () => {
    const page = await registryPage({
      summary: { ...billing, title: EVIL, description: EVIL },
      versions: [
        {
          version: "1.0.0",
          createdAt: EVIL,
          bump: "major",
          publishedBy: EVIL,
          changes: [{ bump: "major", event: EVIL, path: EVIL, message: EVIL }],
        },
      ],
      version: "1.0.0",
      document: hostileDocument,
    });
    expect(page).toContain(ESCAPED_SCRIPT);
    expect(page).toContain('href="#javascript-alert-1"');
    expectNoLiveMarkup(page);
  });

  test("the home page escapes the query and registry fields", () => {
    const page = homePage({
      registries: [{ ...billing, title: EVIL, description: EVIL, latest: EVIL, updatedAt: EVIL }],
      query: EVIL,
    });
    expect(page).toContain(`value="${ESCAPED_SCRIPT}&quot;&gt;&lt;img`);
    expectNoLiveMarkup(page);

    const empty = homePage({ registries: [], query: EVIL });
    expect(empty).toContain(ESCAPED_SCRIPT);
    expectNoLiveMarkup(empty);
  });

  test("the not found page escapes its message", () => {
    const page = notFoundPage(EVIL);
    expect(page).toContain(ESCAPED_SCRIPT);
    expectNoLiveMarkup(page);
  });
});

function hostileWebhook(name: string) {
  const webhook = jsonWebhook({
    type: "object",
    description: EVIL,
    properties: {
      type: { type: "string", const: name },
      [EVIL]: { type: "string", description: EVIL, enum: [EVIL, "</style>"] },
      data: { $ref: `#/components/schemas/${EVIL.replaceAll("~", "~0").replaceAll("/", "~1")}` },
      link: { type: "string", examples: ["javascript:alert(1)"] },
    },
    required: ["type"],
    examples: [{ type: name, [EVIL]: EVIL, link: "javascript:alert(1)" }],
  });
  return { post: { ...webhook.post, summary: EVIL } };
}

function jsonWebhook(schema: unknown) {
  return { post: { requestBody: { content: { "application/json": { schema } } } } };
}

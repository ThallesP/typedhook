import {
  type Bump,
  type GenerateInput,
  LANGS,
  type Lang,
  type RegistryModel,
  type SchemaChange,
  generateCode,
  hashDocument,
  readRegistryDocument,
} from "@typedhook/verify/registry";
import { eventAnchors, eventList } from "./events";
import { formatDate, plural, registryPath } from "./format";
import { highlight } from "./highlight";
import { Html, html } from "./html";
import { page } from "./layout";
import { tabs, titledFrame } from "./tabs";
import { usageCode } from "./usage";
import { versionHistory } from "./versions";

export type RegistrySummary = {
  /** Lowercase GitHub login. */
  owner: string;
  name: string;
  /** OpenAPI info.title of the latest version. */
  title: string;
  description: string | null;
  latest: string;
  /** SQLite CURRENT_TIMESTAMP, like `2026-10-19 03:12:44`. */
  updatedAt: string;
};

export type VersionSummary = {
  version: string;
  createdAt: string;
  /** Null for the first version, or when it isn't known. */
  bump: Bump | null;
  /** Against the previous version. */
  changes: SchemaChange[] | null;
  publishedBy: string | null;
};

export type RegistryPageData = {
  summary: RegistrySummary;
  /** Newest first. */
  versions: VersionSummary[];
  /** The version shown: the latest unless `?version=` picked another. */
  version: string;
  /** That version's OpenAPI 3.1 document. Untrusted: anyone can publish. */
  document: unknown;
};

type GeneratedFile = { lang: Lang; code: string };

type ModelResult = { ok: true; model: RegistryModel } | { ok: false; reason: string };

const langLabel: Record<Lang, string> = { typescript: "TypeScript", python: "Python", go: "Go" };

const langFlag: Record<Lang, string> = { typescript: "", python: " --lang python", go: " --lang go" };

const searchIcon = new Html(
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
);

export function homePage({ registries, query }: { registries: RegistrySummary[]; query: string }): string {
  return page({
    title: "typedhook registry",
    description: "Webhook events published by the products that send them, ready to add to your project as typed code.",
    isHome: true,
    content: html`<section class="hero">
<h1 class="display">Webhook events,<br><span>typed by the sender</span></h1>
<p>Products publish the webhook events they send. Add them to your project as typed code with one command.</p>
<form class="search" action="/" method="get" role="search">
<label class="search-field">${searchIcon}<input type="search" name="q" value="${query}" placeholder="Search registries" aria-label="Search registries" autocomplete="off"></label>
<button type="submit">Search</button>
</form>
</section>
<section class="section"><div class="narrow">${registryList(registries, query.trim())}</div></section>
<section class="guides">
<div class="guide" id="publish">
<span class="guide-step">01</span>
<h2>Publish your events</h2>
<p>Log in with GitHub, then publish from the project that sends the webhooks. Each version lists what changed since the last one.</p>
<div class="terminal">${commandLine("npx typedhook login")}${commandLine("npx typedhook publish")}</div>
</div>
<div class="guide" id="agents">
<span class="guide-step">02</span>
<h2>Use it from your agent</h2>
<p>Add the skill, or connect the MCP server so your agent can search registries, read events and generate code.</p>
<div class="terminal">${commandLine("npx skills add ThallesP/typedhook")}${commandLine(
      "claude mcp add --transport http typedhook https://registry.typedhook.dev/mcp",
    )}</div>
</div>
</section>`,
  });
}

export async function registryPage({ summary, versions, version, document }: RegistryPageData): Promise<string> {
  const { owner, name, title, description, latest } = summary;
  const registry = `${owner}/${name}`;
  const isLatest = version === latest;
  const read = readModel(`${registry}@${version}`, document);
  const files = read.ok ? await generateFiles({ registry, version, hash: await hashDocument(document), document }) : [];
  const events = read.ok ? read.model.events : [];
  const anchors = eventAnchors(events);

  const sections = read.ok
    ? html`${installBlock(registry, name, read.model, files)}${eventsBlock(read.model, name, anchors)}${codeBlock(files)}`
    : html`<p class="notice">This version's document can't be read: ${read.reason}</p>`;
  const olderNotice = isLatest
    ? null
    : html`<p class="notice">You're viewing ${version}. The latest version is <a href="${registryPath(owner, name)}">${latest}</a>.</p>`;

  const toc = html`<nav class="toc" aria-label="On this page">
<p class="toc-title">On this page</p>
<ul>
${files.length > 0 ? html`<li><a href="#install">Install</a></li>` : null}
${read.ok ? html`<li><a href="#events">Events</a></li>` : null}
${events.map((event, index) => html`<li><a class="toc-event" href="#${anchors[index]}">${event.name}</a></li>`)}
${files.length > 0 ? html`<li><a href="#code">Generated code</a></li>` : null}
<li><a href="#versions">Versions</a></li>
</ul>
</nav>`;

  return page({
    title: `${registry} · typedhook registry`,
    description: description ?? `Webhook events of ${title}, with typed code to receive them.`,
    content: html`<section class="registry-hero">
<nav class="crumbs" aria-label="Breadcrumb"><a href="/">registry</a><span>/</span><span>${owner}</span></nav>
<h1 class="display">${title}</h1>
<p class="registry-id"><span class="owner">${owner}/</span>${name}</p>
${description ? html`<p class="lede">${description}</p>` : null}
<div class="facts">
<span class="pill">${version}</span>
${isLatest ? html`<span>latest</span>` : null}
${read.ok ? html`<span><strong>${events.length}</strong> ${events.length === 1 ? "event" : "events"}</span>` : null}
${publishedFacts(versions.find((each) => each.version === version))}
</div>
${olderNotice}
</section>
<div class="registry-body">
<div class="registry-main">
${sections}
<section class="block" id="versions"><h2>Versions<span class="count">${versions.length}</span></h2>${versionHistory(summary, versions, version)}</section>
</div>
<aside class="registry-aside">${toc}</aside>
</div>`,
  });
}

export function notFoundPage(message: string): string {
  return page({
    title: "Not found · typedhook registry",
    description: message,
    content: html`<section class="not-found">
<p class="not-found-code">404</p>
<h1 class="display">Not found</h1>
<p>${message}</p>
<a class="button button-primary" href="/">Browse the registry</a>
</section>`,
  });
}

function registryList(registries: RegistrySummary[], query: string): Html {
  const isSearch = query !== "";
  const heading = isSearch ? html`Results for “${query}”` : "Registries";
  const count = registries.length === 0 ? null : html`<span class="count">${plural(registries.length, "registry", "registries")}</span>`;
  const head = html`<div class="section-head"><h2>${heading}</h2>${count}</div>`;
  if (registries.length === 0 && isSearch) {
    return html`${head}<div class="empty"><h3>Nothing matches “${query}”</h3><p>Search looks at owner, name, title and description. <a class="link" href="/">Show all registries</a></p></div>`;
  }
  if (registries.length === 0) {
    return html`${head}<div class="empty"><h3>No registries yet</h3><p>Publish your webhook events and they show up here. <a class="link" href="#publish">How to publish</a></p></div>`;
  }
  return html`${head}<ul class="registry-list">${registries.map(registryRow)}</ul>`;
}

function registryRow({ owner, name, title, description, latest, updatedAt }: RegistrySummary): Html {
  return html`<li><a class="registry-row" href="${registryPath(owner, name)}">
<span class="registry-id"><span class="owner">${owner}/</span>${name}</span>
<span class="registry-meta"><span class="pill">${latest}</span><span>${formatDate(updatedAt)}</span></span>
<span class="registry-summary"><strong>${title}</strong>${description ? html` · ${description}` : null}</span>
</a></li>`;
}

function commandLine(command: string): Html {
  return html`<div class="command-line"><span class="prompt">$ </span><span class="command">${command}</span></div>`;
}

function installBlock(registry: string, name: string, model: RegistryModel, files: GeneratedFile[]): Html | null {
  if (files.length === 0) return null;
  const commands = tabs(
    "install",
    files.map(({ lang }) => ({
      label: langLabel[lang],
      panel: html`<div class="install-command">${commandLine(`npx typedhook add ${registry}${langFlag[lang]}`)}</div>`,
    })),
  );
  const hasTypescript = files.some(({ lang }) => lang === "typescript");
  const usage = hasTypescript
    ? html`<p class="block-intro usage-intro">It writes <code class="inline-code">src/webhooks/${name}.ts</code> and regenerates it on install. Then route each event to a typed handler:</p>
${titledFrame("route.ts", html`<pre><code>${highlight(usageCode(model, name), "typescript")}</code></pre>`)}`
    : null;
  return html`<section class="block" id="install"><h2>Install</h2>${commands}${usage}</section>`;
}

function eventsBlock(model: RegistryModel, registryName: string, anchors: string[]): Html {
  const list =
    model.events.length === 0
      ? html`<p class="block-intro">This version has no events.</p>`
      : eventList(model, registryName, anchors);
  return html`<section class="block" id="events"><h2>Events<span class="count">${model.events.length}</span></h2>${list}</section>`;
}

function codeBlock(files: GeneratedFile[]): Html | null {
  if (files.length === 0) return null;
  const items = files.map(({ lang, code }) => ({
    label: langLabel[lang],
    panel: html`<div class="scroll"><pre><code>${highlight(code, lang)}</code></pre></div>`,
  }));
  return html`<section class="block" id="code"><h2>Generated code</h2><p class="block-intro">What <code class="inline-code">typedhook add</code> writes for this version.</p>${tabs("code", items)}</section>`;
}

function publishedFacts(shown: VersionSummary | undefined): Html | null {
  if (shown === undefined) return null;
  const by = shown.publishedBy === null ? null : html`<span>by ${shown.publishedBy}</span>`;
  return html`<span>published ${formatDate(shown.createdAt)}</span>${by}`;
}

function readModel(label: string, document: unknown): ModelResult {
  try {
    return { ok: true, model: readRegistryDocument(label, document) };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Every language whose generator handles this document; a language that throws is left out. */
async function generateFiles(input: GenerateInput): Promise<GeneratedFile[]> {
  const files = await Promise.all(
    LANGS.map(async (lang) => {
      try {
        return [{ lang, code: await generateCode(lang, input) }];
      } catch {
        return [];
      }
    }),
  );
  return files.flat();
}

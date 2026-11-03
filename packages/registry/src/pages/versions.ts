import type { Bump, SchemaChange } from "@typedhook/verify/registry";
import { formatDate, plural, registryPath, versionPath } from "./format";
import { type Html, html } from "./html";
import type { RegistrySummary, VersionSummary } from "./render";

/** Changes past this many per version fold into a <details>. */
const MAX_CHANGES_SHOWN = 12;

const badgeClass: Record<Bump, string> = {
  major: "badge badge-major",
  minor: "badge badge-minor",
  patch: "badge badge-patch",
};

const changeClass: Record<Bump, string> = {
  major: "change change-major",
  minor: "change change-minor",
  patch: "change change-patch",
};

export function versionHistory(summary: RegistrySummary, versions: VersionSummary[], shownVersion: string): Html {
  const oldest = versions.at(-1);
  return html`<ol class="versions">${versions.map((item) =>
    versionItem(summary, item, item.version === shownVersion, item === oldest),
  )}</ol>`;
}

function versionItem(
  { owner, name, latest }: RegistrySummary,
  { version, createdAt, bump, changes, publishedBy }: VersionSummary,
  isShown: boolean,
  isOldest: boolean,
): Html {
  const isLatest = version === latest;
  const href = isLatest ? registryPath(owner, name) : versionPath(owner, name, version);
  const isShownOlder = isShown && !isLatest;
  return html`<li class="${isShownOlder ? "version version-current" : "version"}">
<div class="version-head">
<a href="${href}">${version}</a>
${bump === null ? null : html`<span class="${badgeClass[bump]}">${bump}</span>`}
${isLatest ? html`<span class="version-tag">latest</span>` : null}
${isShownOlder ? html`<span class="version-tag">viewing</span>` : null}
<span class="version-when">${formatDate(createdAt)}${publishedBy === null ? null : html` · by ${publishedBy}`}</span>
</div>
${changeList(changes, isOldest)}
</li>`;
}

function changeList(changes: SchemaChange[] | null, isOldest: boolean): Html | null {
  if (changes === null) return isOldest ? html`<p class="version-note">First version</p>` : null;
  if (changes.length === 0) return html`<p class="version-note">No changes to the events</p>`;
  const shown = changes.slice(0, MAX_CHANGES_SHOWN);
  const folded = changes.slice(MAX_CHANGES_SHOWN);
  const more =
    folded.length === 0
      ? null
      : html`<details class="more-changes"><summary>${plural(folded.length, "more change", "more changes")}</summary><ul class="changes">${folded.map(changeItem)}</ul></details>`;
  return html`<ul class="changes">${shown.map(changeItem)}</ul>${more}`;
}

function changeItem({ bump, event, path, message }: SchemaChange): Html {
  return html`<li class="${changeClass[bump]}"><span>${event === "" ? null : html`<code>${event}</code> `}${path === "" ? null : html`<code class="change-path">${path}</code> `}${message}</span></li>`;
}

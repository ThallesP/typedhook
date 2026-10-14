import { findNeighbour } from "fumadocs-core/page-tree";
import { DocsBody, DocsPage } from "fumadocs-ui/layouts/notebook/page";
import { TOCPopover, TOCProvider } from "fumadocs-ui/layouts/notebook/page/slots/toc";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import { AgentsCard } from "@/components/page/agents-card";
import { PageHeader } from "@/components/page/page-header";
import { PageMeta } from "@/components/page/page-meta";
import { PagePager } from "@/components/page/page-pager";
import { PageToc } from "@/components/page/page-toc";
import { getPageGroup } from "@/lib/page-group";
import { getPageMarkdownUrl, getPageSourceUrl } from "@/lib/shared";
import { source } from "@/lib/source";

export default async function Page(props: PageProps<"/docs/[[...slug]]">) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const tree = source.getPageTree();
  const { previous, next } = findNeighbour(tree, page.url);
  const sourceUrl = getPageSourceUrl(page);

  return (
    <DocsPage
      toc={page.data.toc}
      breadcrumb={{ enabled: false }}
      footer={{ enabled: false }}
      tableOfContent={{ footer: <AgentsCard /> }}
      slots={{ toc: { provider: TOCProvider, main: PageToc, popover: TOCPopover } }}
      className="gap-0 pb-20 *:mx-auto *:w-full *:max-w-[720px] md:px-8 md:pt-12 xl:px-16 xl:pt-12"
    >
      <PageHeader
        group={getPageGroup(tree, page.url)}
        heading={page.data.heading ?? page.data.title}
        description={page.data.description}
        markdownUrl={getPageMarkdownUrl(page).url}
        sourceUrl={sourceUrl}
      />
      <DocsBody>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      </DocsBody>
      <PagePager previous={previous} next={next} />
      <PageMeta sourceUrl={sourceUrl} lastModified={page.data.lastModified} />
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}

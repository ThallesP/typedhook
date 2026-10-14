import { CodeBlockTab } from "fumadocs-ui/components/codeblock";
import { Step, Steps } from "fumadocs-ui/components/steps";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { CodeBlock } from "@/components/code-block/code-block";
import { CodeTabs, CodeTabsList, CodeTabsTrigger } from "@/components/code-block/code-tabs";
import { AdapterGrid } from "@/components/docs/adapter-grid";
import { Callout } from "@/components/docs/callout";
import { CheckOrder } from "@/components/docs/check-order";
import { FeatureCard, FeatureCards } from "@/components/docs/feature-cards";
import { LinkCard, LinkCards } from "@/components/docs/link-cards";
import { OptionsTable } from "@/components/docs/options-table";
import { Rules } from "@/components/docs/rules";
import { RuntimeList } from "@/components/docs/runtime-list";
import { WireRequest } from "@/components/docs/wire-request";
import { OutboxPlayground } from "@/components/outbox-playground/outbox-playground";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    pre: CodeBlock,
    table: OptionsTable,
    CodeBlockTabs: CodeTabs,
    CodeBlockTabsList: CodeTabsList,
    CodeBlockTabsTrigger: CodeTabsTrigger,
    CodeBlockTab,
    Steps,
    Step,
    Callout,
    FeatureCards,
    FeatureCard,
    LinkCards,
    LinkCard,
    WireRequest,
    RuntimeList,
    CheckOrder,
    Rules,
    AdapterGrid,
    OutboxPlayground,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}

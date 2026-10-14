import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { Brand } from "@/components/layout/brand";
import { Header } from "@/components/layout/header";
import { SidebarItem } from "@/components/layout/sidebar-item";
import { SidebarSeparator } from "@/components/layout/sidebar-separator";
import { source } from "@/lib/source";

export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      nav={{ title: <Brand />, mode: "top" }}
      themeSwitch={{ enabled: false }}
      sidebar={{
        collapsible: false,
        components: { Item: SidebarItem, Separator: SidebarSeparator },
      }}
      slots={{ header: Header }}
    >
      {children}
    </DocsLayout>
  );
}

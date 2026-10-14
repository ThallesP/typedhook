import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Geist, Geist_Mono, Martian_Mono } from "next/font/google";
import "./global.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const martianMono = Martian_Mono({
  subsets: ["latin"],
  variable: "--font-martian-mono",
  axes: ["wdth"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://typedhook.dev"),
  title: { template: "%s · typedhook", default: "typedhook" },
  description: "Type-safe webhooks for TypeScript, in the Standard Webhooks format.",
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${geist.variable} ${geistMono.variable} ${martianMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}

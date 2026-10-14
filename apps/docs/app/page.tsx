import { ClosingCta } from "@/components/landing/closing-cta";
import { CodeSection } from "@/components/landing/code-section";
import { Hero } from "@/components/landing/hero";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";

export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-[1120px] border-x border-line">
      <LandingHeader />
      <Hero />
      <CodeSection />
      <ClosingCta />
      <LandingFooter />
    </div>
  );
}

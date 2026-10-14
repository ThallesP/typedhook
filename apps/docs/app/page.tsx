import { redirect } from "next/navigation";

// TODO: replace with the landing page once its redesign is approved.
export default function HomePage() {
  redirect("/docs");
}

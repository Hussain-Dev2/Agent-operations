import { Bot } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ComingSoon } from "@/components/coming-soon";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("nav"))("runs") };
}

export default async function Page() {
  const t = await getTranslations();
  return <ComingSoon title={t("nav.runs")} body={t("placeholder.runs")} phase={3} icon={Bot} />;
}

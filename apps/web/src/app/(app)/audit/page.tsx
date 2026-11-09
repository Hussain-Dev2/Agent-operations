import { ScrollText } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ComingSoon } from "@/components/coming-soon";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("nav"))("audit") };
}

export default async function Page() {
  const t = await getTranslations();
  return <ComingSoon title={t("nav.audit")} body={t("placeholder.audit")} phase={3} icon={ScrollText} />;
}

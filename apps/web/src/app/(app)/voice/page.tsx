import { AudioLines } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ComingSoon } from "@/components/coming-soon";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("nav"))("voice") };
}

export default async function Page() {
  const t = await getTranslations();
  return <ComingSoon title={t("nav.voice")} body={t("placeholder.voice")} phase={6} icon={AudioLines} />;
}

import { Cpu } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ComingSoon } from "@/components/coming-soon";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("nav"))("supervisor") };
}

export default async function Page() {
  const t = await getTranslations();
  return <ComingSoon title={t("nav.supervisor")} body={t("placeholder.supervisor")} phase={5} icon={Cpu} />;
}

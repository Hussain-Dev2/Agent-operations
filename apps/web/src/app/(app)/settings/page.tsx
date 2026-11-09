import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getAuthStatus } from "@/lib/server";
import { SettingsView } from "./settings-view";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("nav"))("settings") };
}

export default async function SettingsPage() {
  const t = await getTranslations();
  const status = await getAuthStatus();
  return (
    <div className="max-w-2xl">
      <PageHeader title={t("nav.settings")} description={t("placeholder.settingsBody")} />
      <SettingsView email={status.user?.email ?? ""} />
    </div>
  );
}

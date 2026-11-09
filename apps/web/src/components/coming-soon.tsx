import type { LucideIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "./empty-state";
import { PageHeader } from "./page-header";

/** Placeholder for screens that land in later phases, so navigation is complete from day one. */
export async function ComingSoon({ title, body, phase, icon }: { title: string; body: string; phase: number; icon: LucideIcon }) {
  const t = await getTranslations("common");
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        icon={icon}
        title={title}
        body={body}
        action={<Badge variant="secondary">{t("comingInPhase", { phase })}</Badge>}
      />
    </>
  );
}

import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("common");
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_50%_-10%,color-mix(in_oklch,var(--primary)_18%,transparent),transparent)]"
      />
      <div className="relative mb-8 flex flex-col items-center gap-3 text-center">
        <img src="/icon.svg" alt="" className="size-14 rounded-2xl shadow-lg shadow-primary/10" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("appName")}</h1>
          <p className="text-sm text-muted-foreground">{t("tagline")}</p>
        </div>
      </div>
      <div className="relative w-full max-w-sm">{children}</div>
    </div>
  );
}

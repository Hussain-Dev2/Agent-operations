import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { getAuthStatus } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const status = await getAuthStatus();
  if (status.setupRequired) redirect("/setup");
  if (!status.user) redirect("/login");
  return <AppShell email={status.user.email}>{children}</AppShell>;
}

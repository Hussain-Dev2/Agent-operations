import { redirect } from "next/navigation";
import { getAuthStatus } from "@/lib/server";
import { SetupForm } from "./setup-form";

export default async function SetupPage() {
  const status = await getAuthStatus();
  if (!status.setupRequired) redirect(status.user ? "/" : "/login");
  return <SetupForm />;
}

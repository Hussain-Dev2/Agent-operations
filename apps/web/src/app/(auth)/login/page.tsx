import { redirect } from "next/navigation";
import { getAuthStatus } from "@/lib/server";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const status = await getAuthStatus();
  if (status.setupRequired) redirect("/setup");
  if (status.user) redirect("/");
  return <LoginForm />;
}

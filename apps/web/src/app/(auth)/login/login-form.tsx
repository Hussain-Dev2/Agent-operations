"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type SyntheticEvent } from "react";
import { OtpField } from "@/components/otp-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/errors";

export function LoginForm() {
  const t = useTranslations("auth");
  const errorMessage = useErrorMessage();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  const login = useMutation({
    mutationFn: () => api("/api/auth/login", { body: { email, password, code } }),
    onSuccess: () => {
      window.location.assign("/");
    },
    onError: () => {
      setCode("");
    },
  });

  const submit = (e?: SyntheticEvent): void => {
    e?.preventDefault();
    if (!login.isPending) login.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("signInTitle")}</CardTitle>
        <CardDescription>{t("signInSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {login.error && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(login.error)}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="email">{t("email")}</Label>
            <Input id="email" type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => { setEmail(e.target.value); }} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">{t("password")}</Label>
            <Input id="password" type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => { setPassword(e.target.value); }} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="code">{t("code")}</Label>
            <OtpField id="code" value={code} onChange={setCode} />
          </div>
          <Button type="submit" size="lg" disabled={login.isPending || code.length !== 6 || !email || !password}>
            {login.isPending && <Loader2 className="animate-spin" />}
            {t("signIn")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

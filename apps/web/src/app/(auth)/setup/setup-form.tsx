"use client";

import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useEffect, useState, type SyntheticEvent } from "react";
import { SetupStartResponse } from "@operator/shared";
import { OtpField } from "@/components/otp-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/errors";

export function SetupForm() {
  const t = useTranslations("auth");
  const errorMessage = useErrorMessage();
  const [setupToken, setSetupToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [qr, setQr] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => api("/api/auth/setup/start", { body: { setupToken: setupToken.trim(), email, password }, schema: SetupStartResponse }),
  });
  const verify = useMutation({
    mutationFn: () => api("/api/auth/setup/verify", { body: { email, password, code } }),
    onSuccess: () => {
      window.location.assign("/");
    },
    onError: () => {
      setCode("");
    },
  });

  const enrolment = start.data;
  useEffect(() => {
    if (!enrolment) return;
    void QRCode.toDataURL(enrolment.otpauthUrl, { margin: 1, width: 220, color: { dark: "#0f1216", light: "#ffffff" } }).then(setQr);
  }, [enrolment]);

  const submitStart = (e: SyntheticEvent): void => {
    e.preventDefault();
    start.mutate();
  };
  const submitVerify = (e?: SyntheticEvent): void => {
    e?.preventDefault();
    if (!verify.isPending) verify.mutate();
  };

  if (!enrolment) {
    return (
      <Card>
        <CardHeader>
          <p className="text-xs font-medium text-primary">{t("step", { current: 1, total: 2 })}</p>
          <CardTitle>{t("setupTitle")}</CardTitle>
          <CardDescription>{t("setupSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitStart} className="flex flex-col gap-4">
            {start.error && (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage(start.error)}</AlertDescription>
              </Alert>
            )}
            <div className="grid gap-2">
              <Label htmlFor="token">{t("setupToken")}</Label>
              <Input id="token" dir="ltr" className="font-mono" autoComplete="off" required value={setupToken} onChange={(e) => { setSetupToken(e.target.value); }} />
              <p className="text-xs text-muted-foreground">{t("setupTokenHint")}</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email">{t("email")}</Label>
              <Input id="email" type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => { setEmail(e.target.value); }} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">{t("password")}</Label>
              <Input id="password" type="password" dir="ltr" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => { setPassword(e.target.value); }} />
              <p className="text-xs text-muted-foreground">{t("passwordHint")}</p>
            </div>
            <Button type="submit" size="lg" disabled={start.isPending}>
              {start.isPending && <Loader2 className="animate-spin" />}
              {t("continue")}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <p className="text-xs font-medium text-primary">{t("step", { current: 2, total: 2 })}</p>
        <CardTitle>{t("scanTitle")}</CardTitle>
        <CardDescription>{t("scanSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submitVerify} className="flex flex-col gap-5">
          {verify.error && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(verify.error)}</AlertDescription>
            </Alert>
          )}
          <div className="mx-auto rounded-xl bg-white p-2">
            {qr ? <img src={qr} alt="TOTP QR code" className="size-[220px]" /> : <div className="size-[220px]" />}
          </div>
          <details className="text-center text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t("manualSecret")}</summary>
            <code dir="ltr" className="mt-2 block break-all rounded-md bg-muted p-2 font-mono text-foreground select-all">
              {enrolment.secret}
            </code>
          </details>
          <OtpField id="code" value={code} onChange={setCode} />
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="lg" onClick={() => { start.reset(); }}>
              <ArrowLeft className="rtl:rotate-180" />
              {t("back")}
            </Button>
            <Button type="submit" size="lg" className="flex-1" disabled={verify.isPending || code.length !== 6}>
              {verify.isPending && <Loader2 className="animate-spin" />}
              {t("verify")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

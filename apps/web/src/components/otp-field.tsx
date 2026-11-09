"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

/** 6-digit code input. Always LTR, even in Arabic, since digits are read left to right. */
export function OtpField({ id, value, onChange, onComplete }: { id: string; value: string; onChange: (v: string) => void; onComplete?: () => void }) {
  return (
    <div dir="ltr" className="flex justify-center">
      <InputOTP
        id={id}
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        value={value}
        onChange={onChange}
        {...(onComplete && { onComplete })}
        inputMode="numeric"
        autoComplete="one-time-code"
      >
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <InputOTPSlot key={i} index={i} className="size-11 text-lg" />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  );
}

/**
 * Risky-action policy. Anything matching here ALWAYS pauses for an in-app approval tap
 * (enforced from Phase 3). Voice can never approve. Agents cannot edit this list.
 */
export const RiskCategory = [
  "delete",
  "shell_denylist",
  "send_message",
  "purchase",
  "password_field",
  "system_settings",
  "git_push",
  "db_migration",
  "deploy",
] as const;
export type RiskCategory = (typeof RiskCategory)[number];

interface ShellRule {
  category: RiskCategory;
  pattern: RegExp;
}

export const SHELL_RULES: readonly ShellRule[] = [
  { category: "delete", pattern: /(^|[\s;&|(])(rm|rmdir|del|erase|rd|shred|unlink)(\s|$)/i },
  { category: "delete", pattern: /Remove-Item\b/i },
  { category: "delete", pattern: /\bfind\b.*\s-delete\b/ },
  { category: "shell_denylist", pattern: /\b(mkfs(\.\w+)?|dd\s+if=|format\s+[a-z]:|diskpart|fdisk|parted)\b/i },
  { category: "shell_denylist", pattern: /\b(shutdown|reboot|halt|poweroff)\b/i },
  { category: "shell_denylist", pattern: /\b(chmod|chown)\s+(-R\s+)?\S*\s+\/(\s|$)/ },
  { category: "shell_denylist", pattern: /(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression)\b/i },
  { category: "shell_denylist", pattern: /\bsudo\b/ },
  { category: "git_push", pattern: /\bgit\s+push\b/ },
  { category: "delete", pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/ },
  { category: "db_migration", pattern: /\b(migrate|db:push|drizzle-kit\s+(push|migrate)|prisma\s+migrate|DROP\s+(TABLE|DATABASE)|TRUNCATE)\b/i },
  { category: "deploy", pattern: /\b(vercel\s+(--prod|deploy)|fly\s+deploy|kubectl\s+(apply|delete)|terraform\s+(apply|destroy)|npm\s+publish|pnpm\s+publish)\b/i },
  { category: "system_settings", pattern: /\b(reg\s+(add|delete)|Set-ItemProperty\s+.*HKLM|systemctl\s+(disable|mask|stop)|defaults\s+write|netsh|ufw|iptables)\b/i },
];

/** Returns every risk category a shell command matches (empty = not risky by the static list). */
export function classifyShellCommand(command: string): RiskCategory[] {
  const hits = new Set<RiskCategory>();
  for (const rule of SHELL_RULES) if (rule.pattern.test(command)) hits.add(rule.category);
  return [...hits];
}

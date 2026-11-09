import {
  AudioLines,
  Bot,
  Cpu,
  House,
  KeyRound,
  Monitor,
  ScrollText,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export type NavKey = "home" | "devices" | "runs" | "supervisor" | "approvals" | "providers" | "voice" | "audit" | "settings";

export interface NavItem {
  key: NavKey;
  href: string;
  icon: LucideIcon;
  /** Shown in the mobile bottom bar; the rest live under "More". */
  primary: boolean;
}

export const NAV: readonly NavItem[] = [
  { key: "home", href: "/", icon: House, primary: true },
  { key: "devices", href: "/devices", icon: Monitor, primary: true },
  { key: "runs", href: "/runs", icon: Bot, primary: true },
  { key: "approvals", href: "/approvals", icon: ShieldCheck, primary: true },
  { key: "supervisor", href: "/supervisor", icon: Cpu, primary: false },
  { key: "providers", href: "/providers", icon: KeyRound, primary: false },
  { key: "voice", href: "/voice", icon: AudioLines, primary: false },
  { key: "audit", href: "/audit", icon: ScrollText, primary: false },
  { key: "settings", href: "/settings", icon: Settings, primary: false },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

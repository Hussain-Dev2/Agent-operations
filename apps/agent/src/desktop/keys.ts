/**
 * Key names → X11 keysyms (used by the Wayland portal and by X11). Accepts browser
 * `KeyboardEvent.key` values ("ArrowUp", "Control") as well as short names ("up", "ctrl").
 */
const NAMED: Record<string, number> = {
  enter: 0xff0d,
  return: 0xff0d,
  escape: 0xff1b,
  esc: 0xff1b,
  tab: 0xff09,
  backspace: 0xff08,
  delete: 0xffff,
  del: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  arrowleft: 0xff51,
  left: 0xff51,
  arrowup: 0xff52,
  up: 0xff52,
  arrowright: 0xff53,
  right: 0xff53,
  arrowdown: 0xff54,
  down: 0xff54,
  space: 0x20,
  " ": 0x20,
  shift: 0xffe1,
  control: 0xffe3,
  ctrl: 0xffe3,
  alt: 0xffe9,
  altgraph: 0xfe03,
  meta: 0xffeb,
  super: 0xffeb,
  win: 0xffeb,
  cmd: 0xffeb,
  os: 0xffeb,
  capslock: 0xffe5,
  printscreen: 0xff61,
  contextmenu: 0xff67,
  menu: 0xff67,
  pause: 0xff13,
  scrolllock: 0xff14,
  numlock: 0xff7f,
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = 0xffbe + i - 1;

/** Keysym for a single character: Latin-1 maps directly, everything else uses the Unicode range. */
export function charKeysym(char: string): number {
  const cp = char.codePointAt(0);
  if (cp === undefined) throw new Error("Empty character");
  if (char === "\n" || char === "\r") return NAMED.enter ?? 0xff0d;
  if (char === "\t") return NAMED.tab ?? 0xff09;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 + cp;
}

export function keysym(name: string): number {
  const named = NAMED[name.toLowerCase()];
  if (named !== undefined) return named;
  const cp = name.codePointAt(0);
  if (cp !== undefined && String.fromCodePoint(cp) === name) return charKeysym(name);
  throw new Error(`Unknown key "${name}"`);
}

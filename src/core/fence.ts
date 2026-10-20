import { clean, defuseTags, LIMITS } from "./sanitize.ts";

// Wraps untrusted or stored text as clearly fenced DATA for a prompt. The body is cleaned first (hidden characters out, absurd
// lengths cut with a visible marker, sanitize.ts), then a closing or opening tag of this fence, in any letter case, and role tags
// like <system> are defused, so the text cannot end its own fence or pose as instructions. Cleaning is idempotent: a body
// cleaned earlier at the door passes through unchanged.
export const fence = (tag: string, body: string, max: number = LIMITS.block) =>
  `<${tag}>\n${defuseTags(clean(`fence ${tag}`, body, { max }), tag)}\n</${tag}>`;

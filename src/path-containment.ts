import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function resolvePathUnderRoot(root: string, input: string): string {
  if (input.includes("..")) {
    throw new Error(`Path traversal rejected: ${input}`);
  }
  const base = resolve(root);
  let rootReal: string;
  try {
    rootReal = realpathSync.native(base);
  } catch {
    rootReal = base;
  }
  const candidate = isAbsolute(input) ? resolve(input) : resolve(rootReal, input);
  const targetReal = realpathSync.native(candidate);
  const rel = relative(rootReal, targetReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes replay root: ${input}`);
  }
  return targetReal;
}

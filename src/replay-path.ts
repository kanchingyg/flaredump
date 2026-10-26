import { resolve } from "node:path";

import { resolvePathUnderRoot } from "./path-containment.js";

let replayRoot = resolve(process.cwd());

export function setReplayRoot(root: string): void {
  replayRoot = resolve(root);
}

export function getReplayRoot(): string {
  return replayRoot;
}

export function resolveReplayFilePath(filePath: string): string {
  return resolvePathUnderRoot(replayRoot, filePath);
}

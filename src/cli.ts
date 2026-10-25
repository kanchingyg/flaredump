#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  setGuards,
  startMcpServer,
  explainCrashWithModel,
  createFlareDumpHandlers,
  registerReplayHandler,
} from "./bridge.js";
import { inspectCfCrash, replayCfCrash, loadReplayFile, setReplayRoot, type ReplayUrlOptions } from "./replayer.js";
import type { WorkerHandler } from "./recorder-middleware.js";

function applyReplayRootFromArgv(argv: string[]): void {
  const idx = argv.indexOf("--replay-root");
  if (idx >= 0 && argv[idx + 1]) {
    setReplayRoot(argv[idx + 1]);
    return;
  }
  const fromEnv = process.env.FLAREDUMP_REPLAY_ROOT;
  if (fromEnv) setReplayRoot(fromEnv);
}

function replayUrlOptionsFromArgv(argv: string[]): ReplayUrlOptions {
  if (argv.includes("--unsafe-replay-url")) return { replayHost: false };
  const idx = argv.indexOf("--replay-host");
  if (idx >= 0 && argv[idx + 1]) return { replayHost: argv[idx + 1] };
  return {};
}

function usage(): void {
  process.stderr.write(
    "flaredump — replay Cloudflare Worker crashes offline\n\n" +
      "  npx flaredump replay <file.cfreplay.json>\n" +
      "  npx flaredump --explain <file> [--model ollama/qwen2.5-coder:7b]\n" +
      "  npx flaredump --mcp [--allow-write] [--dry-run] [--replay-root <dir>]\n" +
      "  replay/inspect paths must stay under cwd or --replay-root\n",
  );
}

async function main(argv: string[]): Promise<number> {
  applyReplayRootFromArgv(argv);

  if (argv.includes("--mcp")) {
    if (argv.includes("--allow-write")) setGuards({ allowWrite: true });
    if (argv.includes("--dry-run")) setGuards({ dryRun: true });
    startMcpServer({ handlers: createFlareDumpHandlers() });
    return 0;
  }

  const explainIdx = argv.indexOf("--explain");
  if (explainIdx >= 0) {
    const file = argv[explainIdx + 1];
    if (!file) {
      usage();
      return 2;
    }
    const modelIdx = argv.indexOf("--model");
    const model = modelIdx >= 0 ? argv[modelIdx + 1] : undefined;
    const text = await explainCrashWithModel(file, { model });
    process.stdout.write(text + "\n");
    return 0;
  }

  if (argv[0] === "replay") {
    const file = argv[1];
    if (!file) {
      usage();
      return 2;
    }
    const entryIdx = argv.indexOf("--handler");
    const entry = entryIdx >= 0 ? argv[entryIdx + 1] : "default";
    const { default: mod } = await import(resolve(process.cwd(), "worker-handler.js")).catch(() => ({
      default: null as WorkerHandler | null,
    }));
    const handler =
      (globalThis as { __flaredump_handler?: WorkerHandler }).__flaredump_handler ?? mod;
    if (!handler) {
      process.stderr.write("No worker handler: export default handler from worker-handler.js\n");
      return 1;
    }
    registerReplayHandler(entry, handler);
    const result = await replayCfCrash(file, handler, replayUrlOptionsFromArgv(argv));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.threw ? 1 : 0;
  }

  if (argv[0] && argv[0].endsWith(".cfreplay.json")) {
    const inspected = inspectCfCrash(argv[0]);
    process.stdout.write(inspected.summary + "\n");
    return 0;
  }

  usage();
  return 2;
}

const isMain = process.argv[1]?.includes("cli") || process.argv[1]?.endsWith("flaredump");
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}

export { main, writeFileSync, loadReplayFile };

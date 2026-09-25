import { Worker } from "node:worker_threads";

export function checkedPatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128 || value.some(item => typeof item !== "string" || item.length > 2048)) {
    throw new Error("safeCommandPatterns must be an array of at most 128 regex strings, each at most 2048 characters.");
  }
  for (const pattern of value) {
    try { new RegExp(`^(?:${pattern})$`); }
    catch { throw new Error(`Invalid safe-list regex: ${pattern}`); }
  }
  return value;
}

/** Untrusted regex backtracking cannot stall the extension-host event loop. */
export async function matchesSafeList(patterns: string[], command: string): Promise<boolean> {
  if (!patterns.length) return false;
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const result = workerData.patterns.some(pattern => {
        const match = new RegExp('^(?:' + pattern + ')$').exec(workerData.command);
        return match && match.index === 0 && match[0].length === workerData.command.length;
      });
      parentPort.postMessage(!!result);
    `, { eval: true, workerData: { patterns, command } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Safe-list regex evaluation timed out. Simplify the configured patterns."));
    }, 500);
    worker.once("message", value => { clearTimeout(timer); void worker.terminate(); resolve(value === true); });
    worker.once("error", error => { clearTimeout(timer); void worker.terminate(); reject(error); });
  });
}

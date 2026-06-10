import { execFile } from "node:child_process";

export interface ExecFileUtf8Options {
  allowNonZero?: boolean;
  cwd?: string;
  maxBuffer?: number;
}

export interface ExecFileUtf8Result {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function execFileUtf8(
  command: string,
  args: string[],
  options: ExecFileUtf8Options = {}
): Promise<ExecFileUtf8Result> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024
    }, (err, stdout, stderr) => {
      const exitCode = err
        ? typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1
        : 0;
      if (err && !options.allowNonZero) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

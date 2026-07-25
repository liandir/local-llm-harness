import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import {
  DockerCliTransport,
  writeDockerCliInput
} from "../src/security/commands/dockerCliTransport.js";

describe("isolated Docker CLI transport", () => {
  it("requires an absolute executable and never uses shell syntax", async () => {
    expect(() => new DockerCliTransport({
      executablePath: "docker",
      hostPathGuard: {
        executablePath: "docker",
        trustedCwd: path.resolve("."),
        verify: async () => undefined
      }
    })).toThrow(/absolute/i);
    const transport = nodeTransport();
    const payload = "literal;$(not-a-shell)&still-one-argument";
    const result = await transport.run([
      "-e",
      "process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],env:Object.keys(process.env).sort()}))",
      payload
    ], limits());
    const output = JSON.parse(Buffer.from(result.stdout).toString("utf8")) as {
      cwd: string;
      arg: string;
      env: string[];
    };

    expect(result.exitCode).toBe(0);
    expect(output.arg).toBe(payload);
    expect(path.resolve(output.cwd)).toBe(path.resolve(path.dirname(process.execPath)));
    expect(output.env).toEqual(expect.arrayContaining(["DOCKER_CLI_HINTS", "DOCKER_SCAN_SUGGEST", "NO_COLOR"]));
    expect(output.env).not.toContain("NODE_OPTIONS");
    expect(output.env).not.toContain("HTTP_PROXY");
  });

  it("streams framed stdin and terminates at one combined output capture bound", async () => {
    const transport = nodeTransport();
    async function* input(): AsyncIterable<Uint8Array> {
      yield Buffer.from("abc");
      yield Buffer.from("def");
    }
    const result = await transport.run([
      "-e",
      "process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>process.stderr.write('XYZ'))"
    ], { ...limits(), stdin: input(), maxOutputBytes: 7 });

    expect(result.exitCode).toBe(125);
    expect(Buffer.byteLength(Buffer.from(result.stdout)) + Buffer.byteLength(Buffer.from(result.stderr))).toBe(7);
    expect(result.stdoutTruncated || result.stderrTruncated).toBe(true);
  });

  it("stops an output-flooding child immediately instead of draining until timeout", async () => {
    const transport = nodeTransport();
    const result = await transport.run([
      "-e",
      "const b=Buffer.alloc(65536,120);process.stdout.write(b);setInterval(()=>process.stdout.write(b),1)"
    ], { ...limits(), timeoutMs: 2_000, maxOutputBytes: 1_024 });

    expect(result.exitCode).toBe(125);
    expect(result.stdout).toHaveLength(1_024);
    expect(result.stdoutTruncated).toBe(true);
  });

  it("kills a Docker CLI invocation that exceeds its transport deadline", async () => {
    const transport = nodeTransport();
    await expect(transport.run([
      "-e",
      "setInterval(()=>{},1000)"
    ], { ...limits(), timeoutMs: 25 })).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
  });

  it("settles backpressure when child stdin closes without ever emitting drain", async () => {
    const stdin = new PassThrough();
    stdin.write = (() => false) as typeof stdin.write;
    let closeChild = (): void => undefined;
    const closed = new Promise<void>(resolve => { closeChild = resolve; });
    async function* input(): AsyncIterable<Uint8Array> {
      yield Buffer.from("blocked frame");
      yield Buffer.from("must not be requested");
    }

    const writing = writeDockerCliInput(
      { stdin } as Parameters<typeof writeDockerCliInput>[0],
      input(),
      closed
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    stdin.emit("close");
    closeChild();
    await expect(writing).resolves.toBeUndefined();
  });
});

function nodeTransport(): DockerCliTransport {
  return new DockerCliTransport({
    executablePath: process.execPath,
    hostPathGuard: {
      executablePath: process.execPath,
      trustedCwd: path.dirname(process.execPath),
      verify: async () => undefined
    },
    hostEnvironment: process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : undefined
  });
}

function limits() {
  return { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 };
}

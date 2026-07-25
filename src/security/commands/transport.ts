export interface DockerTransportRunOptions {
  readonly signal?: AbortSignal;
  readonly stdin?: AsyncIterable<Uint8Array>;
  readonly timeoutMs: number;
  /** Combined stdout/stderr capture budget; the transport stops on the first excess byte. */
  readonly maxOutputBytes: number;
}

export interface DockerTransportResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

/** Injectable seam: tests never need a host Docker daemon or child process. */
export interface DockerTransport {
  run(args: readonly string[], options: DockerTransportRunOptions): Promise<DockerTransportResult>;
}

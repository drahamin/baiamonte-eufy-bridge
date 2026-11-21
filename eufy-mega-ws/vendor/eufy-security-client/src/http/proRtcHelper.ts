import { spawn } from "child_process";
import { ensureError } from "../error";

/** Bounded RTC worker; callers stay busy until stop/DTLS cleanup has exited. */
export function runProRtcHelper(python: string, helper: string, request: Record<string, unknown>): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const processHandle = spawn(python, [helper], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let settled = false;
    let abortError: Error | undefined;
    let forceTimeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: (value: unknown) => void, value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimeout) clearTimeout(forceTimeout);
      callback(value);
    };
    const terminate = (error: Error): void => {
      if (abortError || settled) return;
      abortError = error;
      // Keep the station busy until the child closes, including its stop/DTLS cleanup.
      processHandle.kill("SIGTERM");
      forceTimeout = setTimeout(() => processHandle.kill("SIGKILL"), 2_000);
    };
    const timeout = setTimeout(() => {
      terminate(new Error("HomeBase Pro helper timed out"));
    }, 60_000);
    processHandle.stdout.on("data", (chunk: Buffer) => {
      if (abortError || settled) return;
      if (stdout.length + chunk.length > 16 * 1024 * 1024) {
        terminate(new Error("HomeBase Pro helper response exceeded 16 MB"));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    processHandle.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
    });
    processHandle.on("error", (error) => finish(reject, error));
    processHandle.on("close", (code) => {
      if (settled) return;
      if (abortError) {
        finish(reject, abortError);
        return;
      }
      if (code !== 0) {
        finish(reject, new Error(`HomeBase Pro event helper exited ${code}: ${stderr.trim().slice(-300)}`));
        return;
      }
      try {
        finish(resolve, JSON.parse(stdout.toString("utf8")));
      } catch (error) {
        finish(reject, ensureError(error));
      }
    });
    try {
      processHandle.stdin.end(JSON.stringify(request));
    } catch (error) {
      terminate(ensureError(error));
    }
  });
}

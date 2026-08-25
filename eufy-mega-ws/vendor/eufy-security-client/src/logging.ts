/**
 *  Logging utils
 */

import { LogLevel } from "typescript-logging";
import { CategoryProvider } from "typescript-logging-category-style";

export type LoggingCategories = "all" | "main" | "http" | "p2p" | "push" | "mqtt";

export { LogLevel };

export interface Logger {
  trace(message: unknown, ...args: unknown[]): void;
  debug(message: unknown, ...args: unknown[]): void;
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
  fatal?(message: unknown, ...args: unknown[]): void;
}

export declare const dummyLogger: Logger;

export class InternalLogger {
  public static logger: Logger | undefined;
}

const sensitiveLogKey =
  /(serial|station|device|address|host|payload|buffer|data|token|password|passcode|username|email|url|key|account|member|user|pin|image|picture)/i;

const redactLogString = (value: string): string =>
  value
    .replace(/\b(?:https?|wss?|rtsp):\/\/\S+/gi, "[redacted-url]")
    .replace(/\b[A-Z0-9]{10,}\b/g, "[redacted-identifier]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-address]");

const redactLogValue = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (typeof value === "string") return redactLogString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactLogString(value.message) };
  }
  if (Buffer.isBuffer(value)) return `[redacted-buffer:${value.length}]`;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveLogKey.test(key) ? "[redacted]" : redactLogValue(item, seen),
    ])
  );
};

/**
 *
 * Get method name
 *
 *
 */
const getMethodName = function (): string | undefined {
  const matches = new Error("").stack?.split("\n")[6].match(/ at( new){0,1} ([a-zA-Z0-9_.]+) /);
  if (matches !== null && matches !== undefined && matches[2] !== undefined && matches[2] !== "eval") {
    return matches[2];
  }
  return undefined;
};

const provider = CategoryProvider.createProvider("EufySecurityClientProvider", {
  level: LogLevel.Off,
  channel: {
    type: "RawLogChannel",
    write: (msg) => {
      const methodName = getMethodName();
      const method = methodName ? `[${methodName}] ` : "";
      const logMessage = redactLogString(`[${msg.logNames}] ${method}${msg.message}`);
      const safeArgs = (msg.args ?? []).map((value) => redactLogValue(value));

      switch (msg.level) {
        case LogLevel.Trace:
          InternalLogger.logger?.trace(logMessage, ...safeArgs);
          break;
        case LogLevel.Debug:
          InternalLogger.logger?.debug(logMessage, ...safeArgs);
          break;
        case LogLevel.Info:
          InternalLogger.logger?.info(logMessage, ...safeArgs);
          break;
        case LogLevel.Warn:
          InternalLogger.logger?.warn(logMessage, ...safeArgs);
          break;
        case LogLevel.Error:
          InternalLogger.logger?.error(logMessage, ...safeArgs);
          break;
        case LogLevel.Fatal:
          if (InternalLogger.logger && InternalLogger.logger.fatal)
            InternalLogger.logger.fatal(logMessage, ...safeArgs);
          break;
      }
    },
  },
});

export const rootMainLogger = provider.getCategory("main");
export const rootHTTPLogger = provider.getCategory("http");
export const rootMQTTLogger = provider.getCategory("mqtt");
export const rootPushLogger = provider.getCategory("push");
export const rootP2PLogger = provider.getCategory("p2p");

/**
 *  Set logging level
 *
 * @param category
 * @param level
 */
export const setLoggingLevel = function (category: LoggingCategories = "all", level: LogLevel = LogLevel.Off): void {
  switch (category) {
    case "all":
      provider.updateRuntimeSettings({
        level: level,
      });
      break;
    case "main":
      provider.updateRuntimeSettingsCategory(rootMainLogger, {
        level: level,
      });
      break;
    case "http":
      provider.updateRuntimeSettingsCategory(rootHTTPLogger, {
        level: level,
      });
      break;
    case "mqtt":
      provider.updateRuntimeSettingsCategory(rootMQTTLogger, {
        level: level,
      });
      break;
    case "p2p":
      provider.updateRuntimeSettingsCategory(rootP2PLogger, {
        level: level,
      });
      break;
    case "push":
      provider.updateRuntimeSettingsCategory(rootPushLogger, {
        level: level,
      });
      break;
  }
};

/**
 *  Get the logging level
 *
 * @param category
 */
export const getLoggingLevel = function (category: LoggingCategories = "all"): number {
  switch (category) {
    case "all":
      return provider.runtimeConfig.level;
    default:
      return provider.getCategory(category).logLevel;
  }
};

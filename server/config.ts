import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { parse } from "smol-toml";

// Package root — static assets and compiled code live here.
export const ROOT = path.resolve(__dirname, "..");

// User state (config.toml + data/) lives in APP_HOME, resolved as:
//   1. $READER_PROCESSOR_HOME, if set
//   2. the package root itself, when it already holds a config.toml or data/
//      (a dev checkout that predates the home-directory layout)
//   3. ~/.reader-processor
function resolveAppHome(): string {
  const env = process.env.READER_PROCESSOR_HOME;
  if (env) return path.resolve(env);
  if (existsSync(path.join(ROOT, "config.toml")) || existsSync(path.join(ROOT, "data"))) {
    return ROOT;
  }
  return path.join(os.homedir(), ".reader-processor");
}

export const APP_HOME = resolveAppHome();
export const DATA_DIR = path.join(APP_HOME, "data");
const CONFIG_PATH = path.join(APP_HOME, "config.toml");

export interface Config {
  kindleEmail: string;
  sourceLabel: string;
  sentLabel: string;
  daysBack: number;
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing ${CONFIG_PATH}. Copy config.toml.example there and fill in your @kindle.com address.`,
    );
  }
  const raw = parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  const kindleEmail = String(raw.kindle_email ?? "");
  if (!kindleEmail.endsWith("@kindle.com")) {
    throw new Error(`${CONFIG_PATH}: kindle_email must be your @kindle.com address`);
  }
  return {
    kindleEmail,
    sourceLabel: String(raw.source_label ?? "newsletter"),
    sentLabel: String(raw.sent_label ?? "kindle-sent"),
    daysBack: Number(raw.days_back ?? 14),
  };
}

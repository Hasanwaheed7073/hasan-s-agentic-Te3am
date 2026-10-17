import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// YANA_HOME points a second instance (e.g. a test run) at its own data so it never touches yours.
const HOME = process.env.YANA_HOME ? path.resolve(process.env.YANA_HOME) : ROOT;
export const DATA_DIR = path.join(HOME, "data");
export const WORKSPACE_DIR = path.join(HOME, "workspace");
export const BROWSER_PROFILE_DIR = path.join(DATA_DIR, "browser-profile");
// Where provider API keys are saved. A test instance (YANA_HOME) never writes to your real .env.
export const ENV_FILE = path.join(HOME, ".env");

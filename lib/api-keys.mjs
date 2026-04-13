// ─── API Key CRUD helpers ────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { API_KEYS_PATH } from "./utils.mjs";

export function loadApiKeys() {
  try {
    if (!existsSync(API_KEYS_PATH)) return [];
    const data = JSON.parse(readFileSync(API_KEYS_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

export function saveApiKeys(keys) {
  writeFileSync(API_KEYS_PATH, JSON.stringify(keys, null, 2));
}

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfigDir } from "./config";
import type { ManagedCodexModelCatalog } from "./codex-integration-shared";
import { sha256 } from "./codex-integration-shared";
import { findTopLevelAssignment, insertDocumentLine, parseDocument,
  removeDocumentLine, renderDocument } from "./codex-integration-document";

export function getCodexManagedCatalogPath(): string {
  return join(getConfigDir(), "codex", "account-models.json");
}

export function serializeCodexModelCatalog(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Model catalogue must be an object");
  const catalog = value as Record<string, unknown>;
  if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error("Model catalogue must preserve official models");
  const seen = new Set<string>();
  let native = false;
  for (const row of catalog.models) {
    if (!row || typeof row !== "object" || typeof row.slug !== "string" || !row.slug || seen.has(row.slug)) {
      throw new Error("Model catalogue contains invalid or duplicate model IDs");
    }
    seen.add(row.slug);
    if (!row.slug.startsWith("chatgpt-web/")) native = true;
  }
  if (!native) throw new Error("Model catalogue must preserve official models");
  return JSON.stringify(catalog, null, 2) + "\n";
}

export function assertOwnedCatalogFile(record: ManagedCodexModelCatalog): void {
  if (resolve(record.path) !== resolve(getCodexManagedCatalogPath())) throw new Error("Managed catalogue belongs to a different installation");
  if (!existsSync(record.path) || !lstatSync(record.path).isFile() || lstatSync(record.path).isSymbolicLink()
    || sha256(readFileSync(record.path)) !== record.sha256) {
    throw new Error("Managed model catalogue changed outside this installation; refusing to overwrite it");
  }
}

/** Called with the route's restored baseline, before its config/journal transaction commits. */
export function prepareCodexModelCatalog(text: string, prior: ManagedCodexModelCatalog | undefined, value?: unknown): {
  text: string; record: ManagedCodexModelCatalog; write: { path: string; data: string };
} {
  const document = parseDocument(text);
  const current = findTopLevelAssignment(document.lines, "model_catalog_json");
  if (prior) {
    assertOwnedCatalogFile(prior);
    if (current.present !== prior.previous.present || (current.present && current.rawLine !== prior.previous.rawLine)) {
      throw new Error("Codex model_catalog_json changed after setup; refusing to overwrite the user's newer value");
    }
  }
  const path = getCodexManagedCatalogPath();
  if (!prior && existsSync(path)) throw new Error("An unowned model catalogue already exists; refusing to replace it");
  const data = value === undefined && prior ? readFileSync(prior.path, "utf8") : serializeCodexModelCatalog(value);
  const line = `model_catalog_json = ${JSON.stringify(path)}`;
  if (current.index !== undefined) document.lines[current.index] = line;
  // The interrupt hook owns its leading comment/separator, which may precede the first
  // table. Insert before all existing content rather than splitting that owned fragment.
  else insertDocumentLine(document, 0, line);
  return { text: renderDocument(document), record: { path, sha256: sha256(data), previous: prior?.previous ?? current }, write: { path, data } };
}

/** A later user assignment takes precedence, including during emergency route rollback. */
export function restoreCodexModelCatalog(text: string, record: ManagedCodexModelCatalog): string {
  const document = parseDocument(text);
  const current = findTopLevelAssignment(document.lines, "model_catalog_json");
  if (current.rawLine !== `model_catalog_json = ${JSON.stringify(record.path)}` || current.index === undefined) return text;
  if (record.previous.present) document.lines[current.index] = record.previous.rawLine!;
  else removeDocumentLine(document, current.index);
  return renderDocument(document);
}

export function verifyActiveCodexModelCatalog(text: string, record: ManagedCodexModelCatalog): void {
  if (findTopLevelAssignment(parseDocument(text).lines, "model_catalog_json").rawLine
    !== `model_catalog_json = ${JSON.stringify(record.path)}`) {
    throw new Error("Codex model_catalog_json changed after setup; refusing to overwrite the user's newer value");
  }
  assertOwnedCatalogFile(record);
}

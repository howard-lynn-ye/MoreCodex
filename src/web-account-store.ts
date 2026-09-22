import { closeSync, copyFileSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteFile, type AppConfig } from "./config";
import { augmentNativeModelCatalog } from "./model-catalog";
import { validateWebAccountRegistry, type WebAccountRegistry } from "./web-accounts";
import { refreshCodexModelCatalog } from "./codex-integration";

/** Serialize CLI edits and prepare the catalogue before replacing any live configuration. */
export function saveWebAccountRegistry(file: string, before: string | undefined, registry: WebAccountRegistry, config: AppConfig) {
  validateWebAccountRegistry(registry, config);
  const lock = `${file}.lock`;
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch { throw Error(`Account registry is locked by another command: ${lock}. If that command crashed, remove only this lock after checking it has stopped.`); }
  const candidate = `${file}.validate-${process.pid}.json`;
  const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const output = registry.catalogOutputFile;
  let outputBefore: string | undefined;
  let committed = false;
  try {
    if (read(file) !== before) throw Error("Account registry changed concurrently; retry the command");
    const encoded = JSON.stringify(registry, null, 2) + "\n";
    let catalog: string | undefined;
    if (output && !registry.nativeCatalogFile) throw Error("Export requires nativeCatalogFile; run web-accounts catalog");
    if (registry.nativeCatalogFile) {
      const paths = [file, registry.nativeCatalogFile, ...(output ? [output] : [])].map(path => resolve(path).toLowerCase());
      if (new Set(paths).size !== paths.length) throw Error("Registry, native template and exported catalogue must use different files");
      atomicWriteFile(candidate, encoded);
      catalog = JSON.stringify(augmentNativeModelCatalog(JSON.parse(readFileSync(registry.nativeCatalogFile, "utf8")), {
        ...config, webAccountsFile: candidate,
      }), null, 2) + "\n";
      if (output) outputBefore = read(output);
    }
    const suffix = `.backup-${Date.now()}-${process.pid}`;
    if (before !== undefined) copyFileSync(file, file + suffix);
    if (output && outputBefore !== undefined) copyFileSync(output, output + suffix);
    // Individual files are atomically replaced. A stale public ID always fails closed in the router.
    atomicWriteFile(file, encoded); committed = true;
    if (output && catalog) atomicWriteFile(output, catalog);
    // The selected --home and CODEX_HOME must own the installed journal. Other homes are a no-op.
    if (catalog) refreshCodexModelCatalog(JSON.parse(catalog));
  } catch (error) {
    if (committed) {
      if (before !== undefined) atomicWriteFile(file, before);
      else unlinkSync(file);
      if (output && outputBefore !== undefined) atomicWriteFile(output, outputBefore);
      else if (output && existsSync(output)) unlinkSync(output);
    }
    throw error;
  } finally {
    if (existsSync(candidate)) unlinkSync(candidate);
    closeSync(fd); unlinkSync(lock);
  }
}

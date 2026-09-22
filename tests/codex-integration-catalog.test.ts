import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig } from "../src/config";
import { activateCodexIntegration, deactivateCodexIntegration, getCodexManagedCatalogPath,
  getCodexJournalPath, getCodexJournalRecoveryPath, readCodexSubagentProtocol,
  installCodexIntegration, inspectCodexIntegration, refreshCodexModelCatalog,
  uninstallCodexIntegration } from "../src/codex-integration";

const roots: string[] = [];
const savedHome = process.env.CODEX_HOME;
const savedApp = process.env.CODEX_CHATGPT_WEB_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
  if (savedApp === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = savedApp;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(original = 'model = "official-model"\n') {
  const root = mkdtempSync(join(tmpdir(), "codex-managed-catalog-")); roots.push(root);
  process.env.CODEX_HOME = join(root, "codex"); process.env.CODEX_CHATGPT_WEB_HOME = join(root, "bridge");
  mkdirSync(process.env.CODEX_HOME);
  const configPath = join(process.env.CODEX_HOME, "config.toml"); writeFileSync(configPath, original);
  const config = defaultConfig("full"); config.subagentProtocol = "native";
  return { root, configPath, config, original };
}
function catalog(accounts = ["first"]) {
  return { models: [{ slug: "official-model", display_name: "Official", visibility: "list" },
    ...accounts.map(alias => ({ slug: `chatgpt-web/${alias}/stable-id`, display_name: `Actual model ${alias}`, visibility: "list" }))] };
}

test("opt-in catalogue upgrades v10 and exactly restores a pre-existing catalogue assignment", () => {
  const f = fixture('model_catalog_json = "previous.json" # user catalogue\nmodel = "official-model"\n');
  expect(installCodexIntegration(f.config).version).toBe(10);
  const installed = installCodexIntegration(f.config, { modelCatalog: catalog() });
  expect(installed.version).toBe(11);
  expect(readCodexSubagentProtocol()).toBe("native");
  expect(readFileSync(f.configPath, "utf8")).toContain(`model_catalog_json = ${JSON.stringify(getCodexManagedCatalogPath())}`);
  expect(JSON.parse(readFileSync(getCodexManagedCatalogPath(), "utf8")).models[0].slug).toBe("official-model");
  expect(inspectCodexIntegration().errors).toEqual([]);
  expect(deactivateCodexIntegration().active).toBe(false);
  expect(inspectCodexIntegration().active).toBe(false);
  expect(readFileSync(f.configPath, "utf8")).toBe(f.original);
  expect(activateCodexIntegration().active).toBe(true);
  expect(inspectCodexIntegration().routeUrl).toContain("127.0.0.1");
  uninstallCodexIntegration();
  expect(readFileSync(f.configPath, "utf8")).toBe(f.original);
  expect(existsSync(getCodexManagedCatalogPath())).toBe(false);
});

test("catalogue fingerprint resolves either side of an interrupted dynamic update", () => {
  const f = fixture(); installCodexIntegration(f.config, { modelCatalog: catalog() });
  const oldJournal = readFileSync(getCodexJournalPath(), "utf8");
  const oldCatalog = readFileSync(getCodexManagedCatalogPath(), "utf8");
  refreshCodexModelCatalog(catalog(["second"]));
  const newJournal = readFileSync(getCodexJournalPath(), "utf8");
  // New catalogue committed, primary journal still old: finish the update.
  writeFileSync(getCodexJournalPath(), oldJournal);
  expect(inspectCodexIntegration().errors).toEqual([]);
  expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(newJournal);
  // Only recovery intent committed: preserve the old data instead.
  writeFileSync(getCodexManagedCatalogPath(), oldCatalog);
  writeFileSync(getCodexJournalPath(), oldJournal);
  writeFileSync(getCodexJournalRecoveryPath(), newJournal);
  expect(inspectCodexIntegration().errors).toEqual([]);
  expect(readFileSync(getCodexJournalRecoveryPath(), "utf8")).toBe(oldJournal);
});

test("refresh adds and removes accounts atomically while retaining official rows and untouched config", () => {
  const f = fixture(); installCodexIntegration(f.config, { modelCatalog: catalog() });
  const text = readFileSync(f.configPath, "utf8");
  expect(refreshCodexModelCatalog(catalog(["first", "second"])).changed).toBe(true);
  expect(JSON.parse(readFileSync(getCodexManagedCatalogPath(), "utf8")).models).toHaveLength(3);
  expect(refreshCodexModelCatalog(catalog(["second"])).changed).toBe(true);
  expect(JSON.parse(readFileSync(getCodexManagedCatalogPath(), "utf8")).models.map((r: { slug: string }) => r.slug))
    .toEqual(["official-model", "chatgpt-web/second/stable-id"]);
  expect(refreshCodexModelCatalog(catalog(["second"])).changed).toBe(false);
  expect(readFileSync(f.configPath, "utf8")).toBe(text);
  expect(inspectCodexIntegration().errors).toEqual([]);
});

test("a later user catalogue path survives rollback; refresh and reactivation cannot overwrite it", () => {
  const f = fixture(); installCodexIntegration(f.config, { modelCatalog: catalog() });
  writeFileSync(f.configPath, readFileSync(f.configPath, "utf8").replace(
    `model_catalog_json = ${JSON.stringify(getCodexManagedCatalogPath())}`, 'model_catalog_json = "new-user-catalog.json"'));
  expect(() => refreshCodexModelCatalog(catalog(["second"]))).toThrow("user's newer value");
  deactivateCodexIntegration();
  expect(readFileSync(f.configPath, "utf8")).toContain('model_catalog_json = "new-user-catalog.json"');
  expect(readFileSync(f.configPath, "utf8")).not.toContain("127.0.0.1");
  expect(() => activateCodexIntegration()).toThrow("user's newer value");
  uninstallCodexIntegration();
  expect(readFileSync(f.configPath, "utf8")).toContain('model_catalog_json = "new-user-catalog.json"');
});

test("external edits to generated catalogue are never overwritten or deleted", () => {
  const f = fixture(); installCodexIntegration(f.config, { modelCatalog: catalog() });
  const path = getCodexManagedCatalogPath(); writeFileSync(path, "user-edited content\n");
  expect(() => refreshCodexModelCatalog(catalog(["second"]))).toThrow("changed outside");
  uninstallCodexIntegration();
  expect(readFileSync(path, "utf8")).toBe("user-edited content\n");
  expect(readFileSync(f.configPath, "utf8")).toBe(f.original);
});

test("uninstall preserves a generated file retained by a later user config edit", () => {
  const f = fixture(); installCodexIntegration(f.config, { modelCatalog: catalog() });
  const path = getCodexManagedCatalogPath();
  const line = `model_catalog_json = ${JSON.stringify(path)}`;
  writeFileSync(f.configPath, readFileSync(f.configPath, "utf8").replace(line, `${line} # user now owns this setting`));
  expect(inspectCodexIntegration().errors[0]).toContain("user's newer value");
  uninstallCodexIntegration();
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(f.configPath, "utf8")).toContain("user now owns this setting");
});

test("disabled or absent catalogue integration is a no-op; wrong Codex home is rejected", () => {
  const f = fixture();
  expect(refreshCodexModelCatalog(catalog())).toEqual({ changed: false, enabled: false });
  installCodexIntegration(f.config);
  expect(refreshCodexModelCatalog(catalog())).toEqual({ changed: false, enabled: false });
  installCodexIntegration(f.config, { modelCatalog: catalog() });
  process.env.CODEX_HOME = join(f.root, "unrelated-home");
  expect(() => refreshCodexModelCatalog(catalog())).toThrow("not the active config");
});

test("unowned files and malformed catalogues leave the current route and files unchanged", () => {
  const f = fixture();
  expect(() => installCodexIntegration(f.config, { modelCatalog: { models: [{ slug: "chatgpt-web/only" }] } })).toThrow("preserve official");
  expect(() => installCodexIntegration(f.config, { modelCatalog: { models: [{ slug: "same" }, { slug: "same" }] } })).toThrow("duplicate");
  const path = getCodexManagedCatalogPath(); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "previous file");
  expect(() => installCodexIntegration(f.config, { modelCatalog: catalog() })).toThrow("unowned");
  expect(readFileSync(path, "utf8")).toBe("previous file");
  expect(readFileSync(f.configPath, "utf8")).toBe(f.original);
});

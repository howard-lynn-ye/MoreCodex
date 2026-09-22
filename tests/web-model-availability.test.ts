import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { mergeDiscoveredModels } from "../src/web-account-cli";
import { validateWebAccountRegistry, verifiedAccountModels, webModelId, type WebAccount, type WebModelEntry } from "../src/web-accounts";
import { observeModelAvailability, describeModelAvailability } from "../src/web-model-availability";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "web-availability-")); roots.push(root);
  const config = { ...defaultConfig("browser-only"), webAccountsFile: join(root, "accounts.json") };
  const account: WebAccount = { id: "school", label: "School", email: "example@example.test", enabled: true,
    browserHostDescriptorPath: join(root, "browser.json"), solAvailable: true, proAvailable: true,
    userId: "user-test", accountId: "workspace-test", catalogIdentity: { userId: "user-test", accountId: "workspace-test" },
    catalogVerifiedAt: new Date().toISOString(), models: [{ slug: "existing-model", title: "Existing model", available: true, adapterRoute: "chatgpt-web/pro" }] };
  const registry = { version: 2 as const, accounts: [account] };
  return { root, config, account, registry };
}
function unknown(slug: string): WebModelEntry {
  return { slug, title: "Observed title", available: null, availabilityEvidence: observeModelAvailability({}) };
}
test("a listing without boolean permission fields is unknown, including truthy strings", () => {
  expect(observeModelAvailability({})).toMatchObject({ status: "unknown", signals: {} });
  expect(observeModelAvailability({ available: "true", disabled: "false", is_disabled: 0 })).toMatchObject({ status: "unknown", signals: {} });
});
test("explicit denial wins over conflicting positive flags without claiming a real call", () => {
  expect(observeModelAvailability({ available: true })).toMatchObject({ status: "available", signals: { available: true } });
  expect(observeModelAvailability({ disabled: false }).status).toBe("available");
  for (const flags of [{ available: false }, { available: true, disabled: true }, { available: true, is_disabled: true }]) {
    expect(observeModelAvailability(flags).status).toBe("unavailable");
  }
  expect(describeModelAvailability({ available: true, availabilityEvidence: observeModelAvailability({ available: true }) }).requestVerification).toBe("not-recorded-in-registry");
});
test("legacy saved mappings remain selectable but their old booleans are not permission proof", () => {
  const { config, account, registry } = fixture();
  expect(validateWebAccountRegistry(registry, config)).toBe(registry);
  expect(verifiedAccountModels(account)).toHaveLength(1);
  expect(describeModelAvailability(account.models![0]!)).toMatchObject({ status: "unknown", source: "legacy-boolean-unqualified" });
});
test("unknown rediscovery preserves the existing route and stable ID while new unmapped candidates stay hidden", () => {
  const { config, account, registry } = fixture(); const id = webModelId(account, account.models![0]!);
  account.models = mergeDiscoveredModels(account, [unknown("existing-model"), unknown("new-candidate")]);
  validateWebAccountRegistry(registry, config);
  expect(account.models[0]!.available).toBeNull();
  expect(account.models[0]!.adapterRoute).toBe("chatgpt-web/pro");
  expect(verifiedAccountModels(account).map(model => webModelId(account, model))).toEqual([id]);
  expect(account.models[1]!.adapterRoute).toBeUndefined();
});
test("an explicit revocation hides an existing mapping and contradictory evidence is rejected", () => {
  const { config, account, registry } = fixture();
  account.models = mergeDiscoveredModels(account, [{ slug: "existing-model", title: "Observed title", available: false,
    availabilityEvidence: observeModelAvailability({ disabled: true }) }]);
  expect(verifiedAccountModels(account)).toHaveLength(0);
  validateWebAccountRegistry(registry, config);
  account.models![0]!.availabilityEvidence = observeModelAvailability({});
  account.models![0]!.available = true;
  expect(() => validateWebAccountRegistry(registry, config)).toThrow("unknown catalogue permissions");
});
test("CLI can explicitly map an unknown candidate without inventing availability or request acceptance", () => {
  const { root, config, account, registry } = fixture(); account.models = [unknown("new-candidate")];
  writeFileSync(config.webAccountsFile, JSON.stringify(registry)); writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const result = Bun.spawnSync([process.execPath, resolve("src/cli.ts"), "--home", root, "web-accounts", "model", account.id,
    "new-candidate", "--route", "chatgpt-web/pro"], { env: { ...process.env, CODEX_HOME: root }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  const saved = JSON.parse(readFileSync(config.webAccountsFile, "utf8"));
  expect(saved.accounts[0].models[0]).toMatchObject({ available: null, adapterRoute: "chatgpt-web/pro", availabilityEvidence: { status: "unknown" } });
  const status = JSON.parse(new TextDecoder().decode(result.stdout));
  expect(status.accounts[0].discoveredModels[0].available).toBeNull();
  expect(status.accounts[0].selectableModels[0].availability).toMatchObject({ status: "unknown", requestVerification: "not-recorded-in-registry" });
});

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium, type Page } from "playwright-core";
import { atomicWriteFile, getConfigDir, getConfigPath, loadConfig, type AppConfig } from "./config";
import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";
import { readWebAccountRegistry, verifiedAccountModels, webModelId, type WebAccountRegistry, type WebAccount, type WebModelEntry } from "./web-accounts";
import { requireChatGptWebModelRoute } from "./chatgpt-web-models";
import { accountHostControl, accountHostStatus, launchAccountHost, runAccountHost } from "./web-account-host";
import { saveWebAccountRegistry } from "./web-account-store";
import { ExternalBrowserConnection, readExternalBrowserEndpoint } from "./external-browser";
import { cloneWebModelDefinition } from "./web-model-definition";
import { observeModelAvailability, describeModelAvailability } from "./web-model-availability";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return undefined;
  const value = args[index + 1]; if (!value || value.startsWith("--")) throw Error(`${name} requires a value`);
  args.splice(index, 2); return value;
}
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

export function mergeDiscoveredModels(account: WebAccount, observed: Array<Pick<WebModelEntry, "slug" | "title" | "available" | "availabilityEvidence">>): WebModelEntry[] {
  const previous = new Map(account.models?.map(model => [model.slug, model]));
  return observed.map(model => {
    const saved = previous.get(model.slug);
    return { ...model,
      ...(saved?.adapterRoute ? { adapterRoute: saved.adapterRoute } : {}),
      ...(saved?.definition ? { definition: cloneWebModelDefinition({ ...saved.definition, title: model.title }) } : {}),
    };
  });
}

/** Metadata only. Tokens stay inside the enrolled browser's JS context; never saved or returned. */
export async function discoverWebAccount(account: WebAccount) {
  if (account.externalBrowser) {
    const connection = await ExternalBrowserConnection.connect({ ...account.externalBrowser,
      email: account.email, userId: account.userId, accountId: account.accountId });
    try {
      const lease = await connection.createPage();
      try {
        await lease.page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
        await lease.verifyIdentity();
        return await discoverWebModels(lease.page, account);
      } finally { await lease.release(); }
    } finally { await connection.close(); }
  }
  const descriptor = readLauncherBrowserHostDescriptor(account.browserHostDescriptorPath);
  if (descriptor.profile !== "production") throw Error("DEV browser cannot enroll a production Web account");
  const browser = await chromium.connectOverCDP(descriptor.endpoint, { timeout: 10_000 });
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith("https://chatgpt.com/"));
    if (!page) throw Error(`${account.label}: open the dedicated account login surface first`);
    return await discoverWebModels(page, account);
  } finally { await browser.close(); }
}

async function discoverWebModels(page: Page, account: WebAccount) {
    const observed = await page.evaluate(async (expectedEmail) => {
      const response = await fetch("/api/auth/session", { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const session = await response.json();
      if (!response.ok || !session.user?.id || !session.account?.id || !session.accessToken) return { authenticated: false as const };
      const modelsResponse = await fetch("/backend-api/models?history_and_training_disabled=false", {
        credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${session.accessToken}`, "ChatGPT-Account-Id": session.account.id },
      });
      if (!modelsResponse.ok) return { authenticated: true as const, status: modelsResponse.status };
      const catalog = await modelsResponse.json();
      return { authenticated: true as const, status: modelsResponse.status,
        userId: String(session.user.id), accountId: String(session.account.id),
        emailMatches: String(session.user.email).toLowerCase() === expectedEmail.toLowerCase(),
        models: (Array.isArray(catalog.models) ? catalog.models : []).map((model: any) => ({
          slug: model.slug, title: model.title,
          ...(typeof model.available === "boolean" ? { available: model.available } : {}),
          ...(typeof model.disabled === "boolean" ? { disabled: model.disabled } : {}),
          ...(typeof model.is_disabled === "boolean" ? { is_disabled: model.is_disabled } : {}),
        })),
      };
    }, account.email);
    if (!observed.authenticated) throw Error(`${account.label}: the selected browser session requires authentication; other accounts are unchanged`);
    if (observed.status !== 200 || !observed.userId || !observed.accountId || !observed.models?.length) {
      throw Error(`${account.label}: authenticated Web model discovery failed (HTTP ${observed.status}); previous catalogue preserved`);
    }
    if (!observed.emailMatches
      || (account.userId && account.userId !== observed.userId)
      || (account.accountId && account.accountId !== observed.accountId)) {
      throw Error(`${account.label}: account/workspace does not match enrollment. Previous identity and models preserved.`);
    }
    const observedAt = new Date().toISOString();
    return { ...observed, models: observed.models.map((model: { slug: string; title: string; available?: boolean; disabled?: boolean; is_disabled?: boolean }) => {
      const availabilityEvidence = observeModelAvailability(model, observedAt);
      return { slug: model.slug, title: model.title,
        available: availabilityEvidence.status === "unknown" ? null : availabilityEvidence.status === "available", availabilityEvidence };
    }) };
}

export async function webAccountCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  const config = loadConfig();
  const file = config.webAccountsFile ?? join(getConfigDir(), "web-accounts.json");
  const effective: AppConfig = { ...config, webAccountsFile: file };
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const registry: WebAccountRegistry = before ? readWebAccountRegistry(effective)! : { version: 2, accounts: [] };
  const save = () => {
    saveWebAccountRegistry(file, before, registry, effective);
    if (!config.webAccountsFile) {
      const configPath = getConfigPath(); copyFileSync(configPath, `${configPath}.backup-${Date.now()}`);
      atomicWriteFile(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), webAccountsFile: file }, null, 2) + "\n");
    }
  };
  if (["start", "login", "stop", "host-run"].includes(action)) {
    const id = args.shift(); const account = registry.accounts.find(account => account.id === id);
    if (!account) throw Error("Unknown account ID");
    if (account.externalBrowser) throw Error(`${account.label}: this account uses an existing browser. Open that browser normally and approve its supported debugging connection; the bridge does not start, stop, or refresh it. Use discover after connecting.`);
    const executable = option(args, "--executable"); const entry = option(args, "--entry");
    const visible = args.includes("--visible"); if (visible) args.splice(args.indexOf("--visible"), 1);
    if (args.length) throw Error("web-accounts start|login|stop ID [--executable ABSOLUTE_EXE --entry ABSOLUTE_LAUNCHER]");
    if (executable) {
      if (!isAbsolute(executable) || (entry && !isAbsolute(entry))) throw Error("Host paths must be absolute");
      registry.host = { executable, ...(entry ? { entry } : {}) }; save();
    }
    if (action === "host-run") { await runAccountHost(config, registry, account, visible); return; }
    if (action === "stop") { console.log(JSON.stringify(await accountHostControl(account, "stop"))); return; }
    const running = (await accountHostStatus(account)).running;
    if (!running) {
      if (!registry.host?.executable) throw Error("Specify --executable and optional --entry for the account browser host");
      launchAccountHost(account, action === "login");
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          if (!(await accountHostStatus(account)).running) throw Error("Account host is not ready");
          break;
        } catch {
          if (Date.now() >= deadline) throw Error(`${account.label}: account host did not become ready; inspect ${account.sessionHome}/logs/host-stderr.log`);
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
    }
    // Login is issued once after readiness. A slow/failed navigation is not a reason
    // to resend login from the readiness loop and interrupt the user's current page.
    if (action === "login") await accountHostControl(account, "login");
    console.log(JSON.stringify({ account: id, status: running ? "already-running" : "starting", sessionHome: account.sessionHome,
      browserAutomation: true, routeChanged: false, login: action === "login" ? "complete authentication manually in this dedicated account window" : "saved session directory reused; authentication not checked (use discover)" }));
    return;
  } else if (action === "attach-browser") {
    const id = args.shift(); const account = registry.accounts.find(account => account.id === id);
    const userDataDir = option(args, "--user-data-dir");
    if (!account || !userDataDir || !isAbsolute(userDataDir) || args.length) {
      throw Error("web-accounts attach-browser ID --user-data-dir ABSOLUTE_BROWSER_USER_DATA_ROOT");
    }
    account.externalBrowser = { userDataDir };
    // Require fresh discovery before advertising a different session source, even with the same alias.
    delete account.catalogIdentity; delete account.catalogVerifiedAt;
    save();
    console.log(JSON.stringify({ account: id, sessionSource: "existing-browser", userDataDir,
      authenticationCopied: false, authenticationChanged: false, next: "Enable and approve the browser's supported debugging connection, then run web-accounts discover ID", routeChanged: false }));
    return;
  } else if (action === "remove") {
    const id = args.shift();
    const account = registry.accounts.find(account => account.id === id);
    if (!account || args.length) throw Error("web-accounts remove ID");
    // Detach only the configuration. Saved logins, local history and backups are retained.
    registry.accounts = registry.accounts.filter(account => account.id !== id);
    save();
    console.log(JSON.stringify({ removed: id, sessionHomePreserved: account.sessionHome, routeChanged: false }));
    return;
  } else if (action === "add") {
    const id = args.shift(); const label = option(args, "--label"); const email = option(args, "--email");
    const requestedDescriptor = option(args, "--descriptor"); const sessionHome = option(args, "--session-home");
    const userDataDir = option(args, "--user-data-dir");
    if (!id || !label || !email || (!requestedDescriptor && !userDataDir) || !sessionHome || args.length) throw Error("web-accounts add ID --label ALIAS --email EMAIL --session-home ABSOLUTE_PATH [--descriptor ABSOLUTE_PATH | --user-data-dir ABSOLUTE_BROWSER_ROOT]");
    if (requestedDescriptor && userDataDir) throw Error("Choose one browser session source");
    const descriptor = requestedDescriptor ?? join(sessionHome, "runtime", "browser-host.json");
    if (registry.accounts.some(account => account.id === id)) throw Error("Account ID already exists; use rename or discover");
    if (!isAbsolute(sessionHome) || !isAbsolute(descriptor)) throw Error("Account session and descriptor paths must be absolute");
    // Legacy rows are preserved; upgrading them requires explicit discovery, never invented capabilities.
    if (registry.version === 1) { registry.version = 2; for (const account of registry.accounts) account.models ??= []; }
    registry.accounts.push({ id, label, email, enabled: true, sessionHome, browserHostDescriptorPath: descriptor,
      ...(userDataDir ? { externalBrowser: { userDataDir } } : {}),
      solAvailable: true, proAvailable: true, models: [] });
    save();
  } else if (action === "discover" || action === "rename" || action === "model" || action === "enable" || action === "disable") {
    const id = args.shift(); const account = registry.accounts.find(account => account.id === id);
    if (!account) throw Error("Unknown account ID");
    if (action === "discover") {
      if (args.length) throw Error("web-accounts discover ID");
      const observed = await discoverWebAccount(account);
      if (registry.version === 1) { registry.version = 2; for (const value of registry.accounts) value.models ??= []; }
      const discoveredModels = mergeDiscoveredModels(account, observed.models!);
      account.userId = observed.userId; account.accountId = observed.accountId;
      account.catalogIdentity = { userId: observed.userId!, accountId: observed.accountId! };
      account.catalogVerifiedAt = new Date().toISOString(); account.models = discoveredModels;
    } else if (action === "model") {
      const slug = args.shift(); const route = option(args, "--route"); const definitionFile = option(args, "--definition");
      const model = account.models?.find(model => model.slug === slug && model.available !== false);
      if (!model || Boolean(route) === Boolean(definitionFile) || args.length) {
        throw Error("web-accounts model ID ACTUAL_WEB_SLUG (--route chatgpt-web/ADAPTER_ROUTE | --definition ABSOLUTE_JSON); discover first");
      }
      if (definitionFile) {
        if (!isAbsolute(definitionFile)) throw Error("Model definition file must be absolute");
        const definition = cloneWebModelDefinition(JSON.parse(readFileSync(definitionFile, "utf8")));
        if (definition.slug !== model.slug || definition.title !== model.title) throw Error("Model definition must match the authenticated discovery's exact slug and title");
        model.definition = definition; delete model.adapterRoute;
      } else {
        requireChatGptWebModelRoute(route!, { ...config, solAvailable: account.solAvailable, proAvailable: account.proAvailable });
        model.adapterRoute = route; delete model.definition;
      }
    } else if (action === "rename") {
      const label = args.shift(); if (!label || args.length) throw Error("web-accounts rename ID ALIAS"); account.label = label;
    } else { if (args.length) throw Error(`web-accounts ${action} ID`); account.enabled = action === "enable"; }
    save();
  } else if (action === "catalog") {
    const codex = option(args, "--codex"); const output = option(args, "--output");
    if (!codex || !output || args.length || !isAbsolute(codex) || !isAbsolute(output)) throw Error("web-accounts catalog --codex ABSOLUTE_EXE --output ABSOLUTE_JSON");
    const result = spawnSync(codex, ["debug", "models", "--bundled"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    if (result.status !== 0) throw Error("Official Codex bundled metadata export failed");
    const native = JSON.parse(result.stdout);
    const templateFile = join(dirname(file), "native-model-template.json");
    if (new Set([file, templateFile, output, getConfigPath()].map(value => resolve(value).toLowerCase())).size !== 4) {
      throw Error("Catalogue output, template, account registry and bridge config must use different files");
    }
    if (existsSync(templateFile)) copyFileSync(templateFile, `${templateFile}.backup-${Date.now()}`);
    atomicWriteFile(templateFile, JSON.stringify(native)); registry.nativeCatalogFile = templateFile; registry.catalogOutputFile = output; save();
    console.log(JSON.stringify({ catalogue: output, nativeConfigSetting: `model_catalog_json = ${JSON.stringify(output)}`, routeChanged: false }));
    return;
  } else if (action !== "status" || args.length) {
    throw Error("Use web-accounts add, attach-browser, start, login, stop, discover, model, rename, enable, disable, remove, catalog, or status");
  }
  const hostStatuses = await Promise.all(registry.accounts.map(async account => {
    if (!account.externalBrowser) return accountHostStatus(account);
    try {
      // A status check never initiates a privileged browser connection or asks for consent.
      readExternalBrowserEndpoint(account.externalBrowser.userDataDir);
      return { running: false, status: "connection-available-unverified", authenticated: undefined };
    } catch {
      return { running: false, status: "browser-connection-required", authenticated: undefined };
    }
  }));
  console.log(JSON.stringify({ file, accounts: registry.accounts.map((account, index) => ({
    id: account.id, alias: account.label, enabled: account.enabled, sessionHome: account.sessionHome,
    descriptor: account.externalBrowser ? undefined : account.browserHostDescriptorPath,
    sessionSource: account.externalBrowser ? "existing-browser" : "launcher",
    userDataDir: account.externalBrowser?.userDataDir, identityVerified: Boolean(account.catalogIdentity),
    userHash: account.userId ? fingerprint(account.userId) : null, workspaceHash: account.accountId ? fingerprint(account.accountId) : null,
    catalogVerifiedAt: account.catalogVerifiedAt, discoveredModels: account.models?.map(model => ({ slug: model.slug, title: model.title,
      available: model.availabilityEvidence?.status === "available" ? true : model.availabilityEvidence?.status === "unavailable" ? false : null,
      availability: describeModelAvailability(model), routingEnabled: model.available !== false, adapterRoute: model.adapterRoute,
      configuredSelection: model.definition?.selection.kind, capabilities: model.definition?.capabilities, limits: model.definition?.limits })),
    selectableModels: verifiedAccountModels(account).map(model => ({ id: webModelId(account, model), name: `${model.title} ${account.label}`,
      availability: describeModelAvailability(model) })),
    runtime: { ...hostStatuses[index],
      authentication: hostStatuses[index]?.authenticated === true ? "authenticated"
        : hostStatuses[index]?.running && hostStatuses[index]?.status === "signed-out" ? "login-required" : "unverified" },
  })), routeChanged: false, inferenceTransport: "browser-automation" }, null, 2));
}

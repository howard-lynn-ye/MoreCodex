import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { AppConfig } from "./config";
import { CHATGPT_WEB_MODEL_PREFIX, requireChatGptWebModelRoute } from "./chatgpt-web-models";
import { cloneWebModelDefinition, validateWebModelDefinition, type WebModelDefinition } from "./web-model-definition";
import { validateModelAvailability, type WebModelAvailabilityEvidence } from "./web-model-availability";

export interface WebModelEntry {
  /** Exact model slug and title returned by this account's authenticated Web catalogue. */
  slug: string;
  title: string;
  /** Catalogue permission declaration. Null is unknown; older booleans retain their routing semantics. */
  available: boolean | null;
  availabilityEvidence?: WebModelAvailabilityEvidence;
  /** Explicit browser adapter route. Unmapped models remain discoverable but are not advertised. */
  adapterRoute?: string;
  /** Exact semantic browser selection and explicit capabilities for an arbitrary discovered model. */
  definition?: WebModelDefinition;
}

export interface WebModelBinding {
  accountId: string;
  publicModelId: string;
  webModelSlug: string;
}

export interface WebAccountRegistry {
  version: 1 | 2;
  accounts: WebAccount[];
  /** Bundled official Codex metadata; contains no authentication and is not an inference endpoint. */
  nativeCatalogFile?: string;
  catalogOutputFile?: string;
  host?: { executable: string; entry?: string };
}

export interface WebAccount {
  id: string;
  label: string;
  email: string;
  enabled: boolean;
  browserHostDescriptorPath: string;
  /** Existing, user-authorized browser. Its profile owns the saved login; no cookies are copied. */
  externalBrowser?: { userDataDir: string; connectTimeoutMs?: number; connectionTtlMs?: number };
  solAvailable: boolean;
  proAvailable: boolean;
  userId?: string;
  accountId?: string;
  sessionHome?: string;
  models?: WebModelEntry[];
  catalogVerifiedAt?: string;
  catalogIdentity?: { userId: string; accountId: string };
  connectorName?: string;
  tunnel?: AppConfig["tunnel"];
}

export function webModelId(account: WebAccount, model: WebModelEntry): string {
  // Identity, rather than label, prevents a renamed or re-enrolled account from inheriting a route.
  const key = createHash("sha256").update(JSON.stringify([
    account.id, account.userId, account.accountId, model.slug,
  ])).digest("hex").slice(0, 24);
  return `${CHATGPT_WEB_MODEL_PREFIX}${account.id}/m-${key}`;
}

export function verifiedAccountModels(account: WebAccount): WebModelEntry[] {
  if (!account.enabled || !account.userId || !account.accountId
    || account.catalogIdentity?.userId !== account.userId
    || account.catalogIdentity.accountId !== account.accountId
    || !account.catalogVerifiedAt || !Number.isFinite(Date.parse(account.catalogVerifiedAt))) return [];
  // "verified" here refers to account/catalogue identity, not an end-to-end model call.
  // Unknown catalogue permissions may be explicitly mapped for a real guarded
  // request. A mapping itself is never reported as successful-call evidence.
  return (account.models ?? []).filter(model => model.available !== false
    && model.availabilityEvidence?.status !== "unavailable" && (model.adapterRoute || model.definition));
}

export function readWebAccountRegistry(config: AppConfig): WebAccountRegistry | undefined {
  if (!config.webAccountsFile) return undefined;
  return validateWebAccountRegistry(JSON.parse(readFileSync(config.webAccountsFile, "utf8")), config);
}

/** Read on each request so enabling a verified account does not restart active Codex turns. */
export function readWebAccounts(config: AppConfig): WebAccount[] | undefined {
  return readWebAccountRegistry(config)?.accounts;
}

export function validateWebAccountRegistry(value: any, config: AppConfig): WebAccountRegistry {
  if (![1, 2].includes(value?.version) || !Array.isArray(value.accounts)) {
    throw new Error("Invalid ChatGPT web account registry");
  }
  const ids = new Set<string>();
  const descriptors = new Set<string>();
  const sessions = new Set<string>();
  const externalIdentities = new Set<string>();
  for (const account of value.accounts) {
    if (!account || typeof account !== "object"
      || typeof account.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(account.id)
      || typeof account.label !== "string" || !account.label.trim() || account.label.length > 80
      || /[\x00-\x1f\x7f]/.test(account.label)
      || typeof account.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(account.email)
      || typeof account.enabled !== "boolean"
      || typeof account.solAvailable !== "boolean" || typeof account.proAvailable !== "boolean"
      || (account.userId !== undefined && (typeof account.userId !== "string" || !/^user-[A-Za-z0-9_-]+$/.test(account.userId)))
      || (account.accountId !== undefined && (typeof account.accountId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(account.accountId)))
      || typeof account.browserHostDescriptorPath !== "string" || !isAbsolute(account.browserHostDescriptorPath)) {
      throw new Error("Invalid ChatGPT web account entry");
    }
    const descriptor = resolve(account.browserHostDescriptorPath).toLowerCase();
    if (ids.has(account.id) || descriptors.has(descriptor)) {
      throw new Error("ChatGPT web accounts must have unique IDs and independent browser descriptors");
    }
    ids.add(account.id);
    descriptors.add(descriptor);
    if (account.externalBrowser !== undefined) {
      const external = account.externalBrowser;
      if (!external || typeof external !== "object" || typeof external.userDataDir !== "string"
        || !isAbsolute(external.userDataDir)
        || [external.connectTimeoutMs, external.connectionTtlMs].some(value => value !== undefined
          && (!Number.isSafeInteger(value) || value < 1000))) throw Error("Invalid existing-browser configuration");
      const identity = JSON.stringify([resolve(external.userDataDir).toLowerCase(), account.email.toLowerCase(), account.accountId ?? ""]);
      if (externalIdentities.has(identity)) throw Error("Existing browser accounts must have distinct enrolled identities/workspaces");
      externalIdentities.add(identity);
    }
    if (account.sessionHome !== undefined) {
      if (typeof account.sessionHome !== "string" || !isAbsolute(account.sessionHome)) throw Error("Account sessionHome must be absolute");
      const session = resolve(account.sessionHome).toLowerCase();
      if (sessions.has(session)) throw Error("ChatGPT web accounts must have independent persistent session homes");
      sessions.add(session);
    }
    if (account.connectorName !== undefined && (typeof account.connectorName !== "string"
      || !account.connectorName.trim() || /[\x00-\x1f\x7f]/.test(account.connectorName))) throw Error("Invalid account connector name");
    if (account.tunnel !== undefined) {
      const tunnel = account.tunnel;
      if (!tunnel || typeof tunnel !== "object"
        || !["binaryPath", "runtimeKeyFile", "profileDir"].every(key => typeof tunnel[key] === "string" && isAbsolute(tunnel[key]))
        || typeof tunnel.tunnelId !== "string" || !/^tunnel_[a-f0-9]{32}$/.test(tunnel.tunnelId)
        || !["profileName", "alias"].every(key => typeof tunnel[key] === "string" && /^[A-Za-z0-9._-]+$/.test(tunnel[key]))) {
        throw Error("Invalid account Tunnel configuration; use absolute paths and an existing Tunnel ID");
      }
    }
    if (value.version === 2) {
      if (!Array.isArray(account.models)) throw Error("Version 2 accounts require a models array; run web-accounts discover");
      const slugs = new Set<string>();
      for (const model of account.models) {
        if (!model || typeof model.slug !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model.slug)
          || typeof model.title !== "string" || !model.title.trim() || model.title.length > 160
          || /[\x00-\x1f\x7f]/.test(model.title) || (typeof model.available !== "boolean" && model.available !== null)
          || (model.adapterRoute !== undefined && typeof model.adapterRoute !== "string")
          || slugs.has(model.slug)) throw Error("Invalid or duplicate account model entry");
        slugs.add(model.slug);
        validateModelAvailability(model);
        if (model.definition !== undefined) {
          validateWebModelDefinition(model.definition);
          if (model.adapterRoute || model.definition.slug !== model.slug || model.definition.title !== model.title) {
            throw Error("A configured model must match its discovered slug/title and cannot also use a preset route");
          }
        }
        if (model.adapterRoute) requireChatGptWebModelRoute(model.adapterRoute, configForWebAccount(config, account));
      }
    }
  }
  for (const field of ["nativeCatalogFile", "catalogOutputFile"]) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || !isAbsolute(value[field]))) throw Error(`${field} must be absolute`);
  }
  if (value.host !== undefined && (!value.host || typeof value.host !== "object"
    || typeof value.host.executable !== "string" || !isAbsolute(value.host.executable)
    || (value.host.entry !== undefined && (typeof value.host.entry !== "string" || !isAbsolute(value.host.entry))))) throw Error("Account host paths must be absolute");
  return value;
}

export function configForWebAccount(config: AppConfig, account: WebAccount): AppConfig {
  return {
    ...config,
    browserHost: account.externalBrowser ? "external-cdp" : "launcher",
    browserInteractionMode: "automatic",
    browserHostDescriptorPath: account.externalBrowser ? undefined : account.browserHostDescriptorPath,
    externalBrowser: account.externalBrowser ? { ...account.externalBrowser, email: account.email,
      userId: account.userId, accountId: account.accountId } : undefined,
    webAccountIdentity: account.userId && account.accountId
      ? { label: account.label, userId: account.userId, accountId: account.accountId }
      : undefined,
    solAvailable: account.solAvailable,
    proAvailable: account.proAvailable,
    modelAccountLabels: undefined,
    webModelDefinition: undefined,
    webModelBinding: undefined,
    ...(account.connectorName ? { automaticAppName: account.connectorName } : {}),
    ...(account.tunnel ? { tunnel: account.tunnel, automaticTunnel: account.tunnel } : {}),
    // Tool calls share the existing broker. No model API key or alternative inference URL is added.
  };
}

/** Snapshot the complete account/model choice before a turn begins. Later registry edits cannot retarget it. */
export function configForWebModel(config: AppConfig, account: WebAccount, model: WebModelEntry): AppConfig {
  const definition = model.definition ? cloneWebModelDefinition(model.definition) : undefined;
  return {
    ...configForWebAccount(config, account),
    ...(definition && !definition.capabilities.tools ? { mode: "browser-only" as const } : {}),
    webModelDefinition: definition,
    webModelBinding: { accountId: account.id, publicModelId: webModelId(account, model), webModelSlug: model.slug },
    // Staging on a different model would violate the selected model binding.
    experimentalBiggerContext: false,
  };
}

export function resolveWebAccountModel(model: string, config: AppConfig): {
  model: string; config: AppConfig; account?: WebAccount;
} {
  const suffix = model.startsWith(CHATGPT_WEB_MODEL_PREFIX) ? model.slice(CHATGPT_WEB_MODEL_PREFIX.length) : "";
  if (!suffix.includes("/")) return { model, config };
  const parts = suffix.split("/");
  const accounts = readWebAccounts(config);
  const account = parts.length === 2 && accounts?.find(candidate => candidate.id === parts[0]);
  if (!account || !account.enabled) {
    throw new Error(`ChatGPT web account is unknown or disabled: ${parts[0]}`);
  }
  if (!account.userId || !account.accountId) {
    throw new Error(`ChatGPT web account requires identity verification: ${account.label}`);
  }
  if (account.models !== undefined) {
    const selected = verifiedAccountModels(account).find(candidate => webModelId(account, candidate) === model);
    if (!selected) throw Error(`ChatGPT Web ${account.label}: model is unavailable, unverified or not mapped; run web-accounts discover. No fallback was used.`);
    const selectedConfig = configForWebModel(config, account, selected);
    if (selectedConfig.mode === "full" && (!account.tunnel || !account.connectorName)) {
      throw Error(`ChatGPT Web ${account.label}: configure this account's own connectorName and tunnel before using full mode. Another account's tool channel will not be used.`);
    }
    return { model: selected.definition ? model : selected.adapterRoute!, account, config: selectedConfig };
  }
  return { model: CHATGPT_WEB_MODEL_PREFIX + parts[1], config: configForWebAccount(config, account), account };
}

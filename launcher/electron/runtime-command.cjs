const fs = require("node:fs");
const path = require("node:path");

const verifiedOverrides = new Map();

// An explicit deployment always selects one verified CLI/helper bundle. The
// environment is set by the reversible deployment launcher, never by DEV UI.
function explicitRuntimeBundle({ env = process.env, version = require("../../package.json").version,
  platform = process.platform, arch = process.arch } = {}) {
  const root = env.CODEX_CHATGPT_WEB_RUNTIME_BUNDLE?.trim();
  const bundleId = env.CODEX_CHATGPT_WEB_RUNTIME_BUNDLE_ID?.trim();
  if (!root && !bundleId) return null;
  if (!root || !path.isAbsolute(root) || !/^[a-f0-9]{64}$/.test(bundleId || "")) {
    throw new Error("Explicit runtime deployment requires an absolute bundle path and SHA256 bundle ID");
  }
  const key = JSON.stringify([root, bundleId, version, platform, arch]);
  if (!verifiedOverrides.has(key)) {
    // Lazy import: runtime-install also uses runtimeBundlePaths from this module.
    const { validateRuntimeBundle } = require("./runtime-install.cjs");
    const verifiedRoot = validateRuntimeBundle(root, { version, platform, arch, bundleId });
    verifiedOverrides.set(key, Object.freeze({
      ...runtimeBundlePaths(verifiedRoot, platform), bundleId,
      helperScript: path.join(verifiedRoot, "app", "browser-helper.cjs"),
    }));
  }
  return verifiedOverrides.get(key);
}

function runtimeBundlePaths(runtimeRoot, platform = process.platform) {
  return {
    runtimeRoot,
    executable: path.join(runtimeRoot, "runtime", platform === "win32" ? "bun.exe" : "bun"),
    entrypoint: path.join(runtimeRoot, "app", "cli.js"),
  };
}

function packagedRuntimePaths(resourcesPath, platform = process.platform) {
  return runtimeBundlePaths(path.join(resourcesPath, "runtime"), platform);
}

function sourceRuntimeInvocation(sourceRoot, args) {
  return {
    executable: process.env.CODEX_CHATGPT_WEB_BUN?.trim()
      || process.env.CODEX_WEB_GPT_BUN?.trim()
      || "bun",
    args: ["run", path.join(sourceRoot, "src", "cli.ts"), ...args],
    cwd: sourceRoot,
  };
}

function runtimeInvocation({ app, sourceRoot, installedRuntimeRoot, args }) {
  if (!Array.isArray(args)) throw new Error("Runtime arguments must be an array");
  const explicit = explicitRuntimeBundle();
  if (explicit) return { executable: explicit.executable, args: [explicit.entrypoint, ...args], cwd: explicit.runtimeRoot };
  if (!app.isPackaged) return sourceRuntimeInvocation(sourceRoot, args);

  if (!installedRuntimeRoot || !path.isAbsolute(installedRuntimeRoot)) {
    throw new Error("Packaged launcher runtime has not been installed into durable local storage");
  }
  const { runtimeRoot, executable, entrypoint } = runtimeBundlePaths(installedRuntimeRoot);
  if (!fs.existsSync(executable)) throw new Error(`Bundled Bun runtime is missing: ${executable}`);
  if (!fs.existsSync(entrypoint)) throw new Error(`Bundled runtime entrypoint is missing: ${entrypoint}`);
  return {
    executable,
    args: [entrypoint, ...args],
    cwd: runtimeRoot,
  };
}

function embeddedRuntimeInvocation({ app, sourceRoot, args }) {
  if (!Array.isArray(args)) throw new Error("Runtime arguments must be an array");
  const explicit = explicitRuntimeBundle();
  if (explicit) return { executable: explicit.executable, args: [explicit.entrypoint, ...args], cwd: explicit.runtimeRoot };
  if (!app.isPackaged) return sourceRuntimeInvocation(sourceRoot, args);
  const { runtimeRoot, executable, entrypoint } = packagedRuntimePaths(process.resourcesPath);
  if (!fs.existsSync(executable)) throw new Error(`Embedded Bun runtime is missing: ${executable}`);
  if (!fs.existsSync(entrypoint)) throw new Error(`Embedded runtime entrypoint is missing: ${entrypoint}`);
  return {
    executable,
    args: [entrypoint, ...args],
    cwd: runtimeRoot,
  };
}

module.exports = {
  explicitRuntimeBundle,
  embeddedRuntimeInvocation,
  packagedRuntimePaths,
  runtimeBundlePaths,
  runtimeInvocation,
};

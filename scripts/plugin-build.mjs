import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const pluginRoot = process.cwd();
const packageJsonPath = path.join(pluginRoot, "package.json");
const generatedModulePath = path.join(pluginRoot, "src", "pluginBuildInfo.generated.ts");
const buildInfoJsonPath = path.join(pluginRoot, ".simularca-plugin-build-info.json");
const distPackageJsonPath = path.join(pluginRoot, "dist", "package.json");

function resolveBuildKind(args) {
  return args.includes("--watch") ? "dev" : "build";
}

function loadPackageJson() {
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function buildGeneratedModuleSource(buildInfo) {
  return [
    "export const PLUGIN_BUILD_INFO = {",
    `  version: ${JSON.stringify(buildInfo.version)},`,
    `  baseVersion: ${JSON.stringify(buildInfo.baseVersion)},`,
    `  commitsSinceAnchor: ${String(buildInfo.commitsSinceAnchor)},`,
    `  buildKind: ${JSON.stringify(buildInfo.buildKind)},`,
    `  buildTimestampIso: ${JSON.stringify(buildInfo.buildTimestampIso)},`,
    `  commitSha: ${JSON.stringify(buildInfo.commitSha)},`,
    `  commitShortSha: ${JSON.stringify(buildInfo.commitShortSha)},`,
    `  commitSubject: ${JSON.stringify(buildInfo.commitSubject)}`,
    "} as const;",
    "",
    "export const PLUGIN_VERSION = PLUGIN_BUILD_INFO.version;",
    ""
  ].join("\n");
}

function buildInfoFromPackage(buildKind) {
  const packageJson = loadPackageJson();
  const version =
    typeof packageJson.version === "string" && packageJson.version.trim()
      ? packageJson.version.trim()
      : "0.0.0";
  return {
    version,
    baseVersion: version,
    commitsSinceAnchor: 0,
    buildKind,
    buildTimestampIso: new Date().toISOString(),
    commitSha: null,
    commitShortSha: null,
    commitSubject: null
  };
}

function writePluginArtifacts(buildInfo) {
  const sourcePackageJson = loadPackageJson();
  mkdirSync(path.dirname(generatedModulePath), { recursive: true });
  mkdirSync(path.dirname(distPackageJsonPath), { recursive: true });
  writeFileSync(generatedModulePath, buildGeneratedModuleSource(buildInfo), "utf8");
  writeFileSync(buildInfoJsonPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
  writeFileSync(
    distPackageJsonPath,
    `${JSON.stringify({ ...sourcePackageJson, version: buildInfo.version }, null, 2)}\n`,
    "utf8"
  );
}

function resolveTypescriptBin() {
  const pluginRequire = createRequire(pathToFileURL(packageJsonPath));
  return pluginRequire.resolve("typescript/bin/tsc");
}

async function run() {
  const extraArgs = process.argv.slice(2);
  const buildKind = resolveBuildKind(extraArgs);
  const buildInfo = buildInfoFromPackage(buildKind);

  writePluginArtifacts(buildInfo);

  const tscBinPath = resolveTypescriptBin();
  const child = spawn(process.execPath, [tscBinPath, "-p", "tsconfig.json", ...extraArgs], {
    cwd: pluginRoot,
    stdio: "inherit",
    shell: false
  });

  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Plugin build failed with exit code ${String(code)}.`));
    });
  });
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

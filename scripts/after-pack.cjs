const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { listPackage } = require("@electron/asar");

const REQUIRED_ASAR_FILES = [
  "/src/panel/lib/payload-draft.js",
  "/src/panel/lib/payload-draft.mjs",
];

function verifyRuntimeFiles(context, productName) {
  const resourcesPath = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${productName}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const archivePath = path.join(resourcesPath, "app.asar");
  // `listPackage` returns OS-native separators, so on Windows entries look like
  // `\src\panel\lib\payload-draft.js`. Normalize to a leading-slash POSIX path
  // before comparing against REQUIRED_ASAR_FILES.
  const toPosixKey = (file) => {
    const forward = file.replace(/\\/g, "/");
    return forward.startsWith("/") ? forward : `/${forward}`;
  };
  const archivedFiles = new Set(listPackage(archivePath).map(toPosixKey));
  const missingFiles = REQUIRED_ASAR_FILES.filter((file) => !archivedFiles.has(toPosixKey(file)));
  if (missingFiles.length) {
    throw new Error(`Release app.asar is missing required runtime files: ${missingFiles.join(", ")}`);
  }
  // Streamed into build-release.mjs's log so the (otherwise silent) afterPack
  // stage shows a milestone — for --dir this is the near-final step.
  console.log(`afterPack: app.asar 必需文件校验通过（${archivedFiles.size} 项）`);
}

function replacePlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
  if (!pattern.test(plist)) {
    return plist.replace("</dict>", `  <key>${key}</key>\n  <string>${value}</string>\n</dict>`);
  }
  return plist.replace(pattern, `$1${value}$3`);
}

function removePlistString(plist, key) {
  return plist.replace(new RegExp(`\\s*<key>${key}</key>\\s*<string>[^<]*</string>`), "");
}

function updatePlist(plistPath, changes, removals = []) {
  let plist = fs.readFileSync(plistPath, "utf8");
  for (const [key, value] of Object.entries(changes)) {
    plist = replacePlistString(plist, key, value);
  }
  for (const key of removals) {
    plist = removePlistString(plist, key);
  }
  fs.writeFileSync(plistPath, plist);
}

module.exports = async function afterPack(context) {
  const productName = context.packager.appInfo.productFilename;
  verifyRuntimeFiles(context, productName);

  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = path.join(context.appOutDir, `${productName}.app`);
  const macosPath = path.join(appPath, "Contents", "MacOS");
  const sourceExecutable = path.join(macosPath, productName);
  const targetExecutable = path.join(macosPath, "Electron");
  fs.renameSync(sourceExecutable, targetExecutable);
  updatePlist(path.join(appPath, "Contents", "Info.plist"), {
    CFBundleExecutable: "Electron",
  });

  const frameworksPath = path.join(appPath, "Contents", "Frameworks");
  for (const suffix of ["", " (GPU)", " (Plugin)", " (Renderer)"]) {
    const sourceName = `${productName} Helper${suffix}`;
    const targetName = `Electron Helper${suffix}`;
    const sourceHelperPath = path.join(frameworksPath, `${sourceName}.app`);
    const targetHelperPath = path.join(frameworksPath, `${targetName}.app`);
    const sourceHelperExecutable = path.join(sourceHelperPath, "Contents", "MacOS", sourceName);
    const targetHelperExecutable = path.join(sourceHelperPath, "Contents", "MacOS", targetName);

    fs.renameSync(sourceHelperExecutable, targetHelperExecutable);
    updatePlist(
      path.join(sourceHelperPath, "Contents", "Info.plist"),
      {
        CFBundleIdentifier: "com.github.Electron.helper",
        CFBundleName: targetName,
      },
      ["CFBundleDisplayName", "CFBundleExecutable", "CFBundleVersion"],
    );
    fs.renameSync(sourceHelperPath, targetHelperPath);
  }

  if (!process.env.CSC_LINK && !process.env.CSC_NAME) {
    const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`Failed to apply fallback ad-hoc signature: ${result.stderr || result.stdout || "codesign failed"}`);
    }
  }
};

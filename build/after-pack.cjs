const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Ad-hoc sign the assembled macOS bundle so Gatekeeper sees a valid seal.
// electron-builder skips re-signing when no identity is configured, leaving
// Electron's original signature invalid after the bundle is modified —
// downloaded (quarantined) copies then fail with "Quill is damaged and can't
// be opened", which right-click → Open cannot bypass. A valid ad-hoc seal
// downgrades that to the bypassable "unidentified developer" dialog.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
};

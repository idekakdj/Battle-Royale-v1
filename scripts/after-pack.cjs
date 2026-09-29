/**
 * electron-builder `afterPack` hook (WP-L, UPGRADE-PLAN §5.6).
 *
 * When `win.signAndEditExecutable` is false (the workaround for the winCodeSign
 * symlink-extraction failure on Windows without Developer Mode — "A required
 * privilege is not held by the client"), electron-builder no longer stamps the
 * app icon and version resources onto the exe. This hook does it with the
 * `rcedit` package instead, so `Gladiator Kingdom.exe` still shows the right
 * icon, file/product version and company strings in Explorer, the taskbar and
 * "Apps & features". With signAndEditExecutable left at its default (true)
 * electron-builder does all of this itself and the hook is a no-op.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  // scripts/dist.mjs feeds electron-builder an unpacked Electron (electronDist),
  // which still carries Electron's demo app; it is never used — drop it.
  const defaultApp = path.join(context.appOutDir, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp);

  const options = context.packager.platformSpecificBuildOptions || {};
  if (options.signAndEditExecutable !== false) return;

  const appInfo = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const icon = path.join(context.packager.projectDir, 'build', 'icon.ico');
  if (!fs.existsSync(exe)) throw new Error(`afterPack: executable not found: ${exe}`);
  if (!fs.existsSync(icon)) throw new Error(`afterPack: icon not found: ${icon} (run npm run icons)`);

  const winVersion =
    typeof appInfo.getVersionInWeirdWindowsForm === 'function'
      ? appInfo.getVersionInWeirdWindowsForm()
      : `${String(appInfo.version).split(/[-+]/)[0]}.0`;

  const { rcedit } = await import('rcedit');
  await rcedit(exe, {
    icon,
    'file-version': winVersion,
    'product-version': winVersion,
    'requested-execution-level': 'asInvoker',
    'version-string': {
      CompanyName: appInfo.companyName || appInfo.productName,
      FileDescription: appInfo.productName,
      ProductName: appInfo.productName,
      InternalFilename: appInfo.productFilename,
      OriginalFilename: `${appInfo.productFilename}.exe`,
      LegalCopyright: appInfo.copyright || '',
    },
  });
  console.log(`  • afterPack: stamped icon + version ${winVersion} onto ${path.basename(exe)} (rcedit)`);
};

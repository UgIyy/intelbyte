import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** Install root (windows/ in dev, app/ in portable release). */
export function appRoot() {
  if (process.env.INTELBYTE_APP_ROOT) return process.env.INTELBYTE_APP_ROOT;
  if (process.pkg) return dirname(process.execPath);
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Node binary used to spawn shield / tray workers. */
export function nodeExe() {
  return process.env.INTELBYTE_NODE || process.execPath;
}

export function binJs() {
  return join(appRoot(), 'bin', 'intelbyte.js');
}

export function trayScript() {
  return join(appRoot(), 'scripts', 'intelbyte-tray.ps1');
}

/**
 * WSL path helpers shared by the picker, filesystem and shell plugins.
 *
 * A WSL workspace is addressed by its Windows UNC spelling,
 * `\\wsl.localhost\<distro>\home\me\proj`, because that form already satisfies
 * DSH's "fully qualified absolute path" checks. Everything that has to act
 * inside the distro (running commands) converts it back to a Linux path.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const UNC = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i;

/** Virtual root of the picker's WSL view (lists the installed distributions). */
export const WSL_ROOT = '\\\\wsl.localhost';

/**
 * Parse a WSL UNC path.
 * @param {unknown} path candidate path.
 * @returns {{distro: string, linuxPath: string} | undefined} distro name and absolute Linux path.
 */
export function parseWslUnc(path) {
  if (typeof path !== 'string') return undefined;
  const match = UNC.exec(path);
  if (match === null) return undefined;
  const rest = (match[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return { distro: match[1], linuxPath: `/${rest}` };
}

/** Whether the path is the picker's virtual WSL root (`\\wsl.localhost`, any slash style). */
export function isWslRoot(path) {
  return typeof path === 'string' && /^[\\/]{2}wsl\.localhost[\\/]*$/i.test(path);
}

/**
 * Build the UNC spelling of a Linux path inside a distro.
 * @param {string} distro distribution name.
 * @param {string} linuxPath absolute Linux path.
 */
export function uncFromLinux(distro, linuxPath) {
  return `${WSL_ROOT}\\${distro}${linuxPath.replace(/\//g, '\\')}`;
}

/**
 * Map a POSIX-absolute path typed by the model onto something the Windows
 * filesystem can open, when the base directory is a WSL workspace.
 * `/mnt/c/x` becomes `C:\x`; any other `/x` becomes the distro's UNC path.
 * Windows-style and relative paths are returned unchanged.
 * @param {string} cwd base directory the path resolves against.
 * @param {string} path requested path.
 */
export function mapPosixPath(cwd, path) {
  if (typeof path !== 'string' || !/^\/(?!\/)/.test(path)) return path;
  const wsl = parseWslUnc(cwd);
  if (wsl === undefined) return path;
  const mnt = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(path);
  if (mnt !== null) return `${mnt[1].toUpperCase()}:\\${(mnt[2] ?? '').replace(/\//g, '\\')}`;
  return uncFromLinux(wsl.distro, path);
}

/** Absolute path of wsl.exe, falling back to PATH lookup. */
export function wslExecutable() {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const candidate = join(root, 'System32', 'wsl.exe');
  return existsSync(candidate) ? candidate : 'wsl.exe';
}

/**
 * argv that runs `command` with bash inside a distro. The command travels as
 * base64 in `$0` and is `eval`ed, which keeps quoting, newlines and non-ASCII
 * text intact through the Windows command line.
 * @param {{distro: string, linuxPath: string}} target distro and Linux working directory.
 * @param {string} command bash source.
 */
export function buildWslArgv(target, command) {
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  return [
    wslExecutable(),
    '-d', target.distro,
    '--cd', target.linuxPath,
    '-e', 'bash', '-lc',
    'eval "$(printf %s "$0" | base64 -d)"',
    encoded,
  ];
}

let distroCache;

/**
 * Installed WSL distributions (docker helper distros excluded). Cached for a
 * few seconds because the picker lists it on every home-directory visit.
 * @returns {Promise<string[]>} distro names; empty when WSL is unavailable.
 */
export function listDistros() {
  const now = Date.now();
  if (distroCache !== undefined && now - distroCache.at < 5000) return distroCache.value;
  const value = new Promise((resolve) => {
    execFile(wslExecutable(), ['-l', '-q'], { encoding: 'buffer', windowsHide: true, timeout: 8000 }, (error, stdout) => {
      if (error !== null || !Buffer.isBuffer(stdout)) return resolve([]);
      // wsl.exe writes UTF-16LE; fall back to UTF-8 if no NULs are present.
      const text = stdout.includes(0) ? stdout.toString('utf16le') : stdout.toString('utf8');
      resolve(
        text
          .replace(/^\uFEFF/, '')
          .split(/\r?\n/)
          .map((line) => line.replace(/\0/g, '').trim())
          .filter((name) => name.length > 0 && !/^docker-desktop/i.test(name)),
      );
    });
  });
  distroCache = { at: now, value };
  return value;
}

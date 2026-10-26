/**
 * dsh-wsl: WSL workspaces for DeepSeek Harness on Windows.
 *
 * A WSL workspace is the UNC path `\\wsl.localhost\<distro>\<linux path>`.
 * This plugin wraps three existing services and only changes behaviour for
 * such paths; every other path goes through the original implementation:
 *
 *  - `ctx.directoryPicker` (browse backend): lists distros and Linux folders.
 *  - `ctx.fs`: writes and edits files without hard links or Windows DACL calls,
 *    neither of which works on the 9P-backed UNC share.
 *  - `ctx.shell`: runs the `pwsh` tool's command with bash inside the distro.
 *
 * No DSH package is imported, so the file can live outside the DSH install.
 * Classes DSH owns (FsError, DirectoryPickerError) are taken from instances
 * of the original services.
 */
import { open, mkdir, readdir, stat as nodeStat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildWslArgv,
  isWslRoot,
  listDistros,
  mapPosixPath,
  parseWslUnc,
  uncFromLinux,
} from './wsl-path.js';

export const name = 'dsh-wsl';

/** Path of the picker's virtual top level, where drives and WSL distributions are listed. */
const COMPUTER_ROOT = '\\\\';
const COMPUTER_LABEL = /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? '此电脑' : 'This PC';

const PATCHED = Symbol.for('dsh-wsl.patched');
const SAFE_CWD = process.env.SystemRoot ?? 'C:\\Windows';
const MAX_DIFF_BASIS_BYTES = 10 * 1024 * 1024;

/** Distro seen most recently; resolves POSIX-rooted `workdir` values that carry no distro. */
let lastDistro;

const noteDistro = (parsed) => {
  if (parsed !== undefined) lastDistro = parsed.distro;
  return parsed;
};

/** Install `patch` on `object`, restore on dispose, and refuse to wrap twice. */
function patchObject(ctx, object, label, apply) {
  if (object[PATCHED]) {
    ctx.logger?.('dsh-wsl').warn?.(`${label} is already patched; skipping`);
    return;
  }
  const originals = new Map();
  const replace = (key, value) => {
    if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(object, key));
    object[key] = value;
  };
  object[PATCHED] = true;
  apply(replace);
  ctx.on('dispose', () => {
    for (const [key, descriptor] of originals) {
      if (descriptor === undefined) delete object[key];
      else Object.defineProperty(object, key, descriptor);
    }
    delete object[PATCHED];
  });
}

/* ------------------------------------------------------------------ */
/* Directory picker                                                    */
/* ------------------------------------------------------------------ */

function patchDirectoryPicker(ctx) {
  const picker = ctx.directoryPicker;
  const capability = picker.capability();
  if (capability?.kind !== 'browse') {
    ctx.logger?.('dsh-wsl').warn?.(
      `directoryPicker is "${capability?.kind}", not "browse"; WSL folders cannot be picked. ` +
        'Disable the directory-picker row (see wsl.patch.yml).',
    );
    return;
  }
  const originalList = capability.list;
  const originalCreate = capability.createDirectory;
  let PickerError;
  const failure = (code, path, message) => {
    if (PickerError !== undefined) return new PickerError(code, path, message);
    return Object.assign(new Error(message), { code, path, name: 'DirectoryPickerError' });
  };
  // Borrow DirectoryPickerError from the backend by provoking its path check.
  Promise.resolve(originalList('relative-path-probe')).catch((error) => {
    if (error?.name === 'DirectoryPickerError') PickerError = error.constructor;
  });

  const maxEntries = 1000;
  const sortByName = (a, b) => a.name.localeCompare(b.name);

  /**
   * The browser collapses the breadcrumb chain into a "Home" crumb whenever
   * `home` is one of the crumbs, which hides every ancestor (drive roots, other
   * drives). Reporting a `home` that is never on a chain keeps the full chain
   * visible; the backslash makes the client infer the Windows separator.
   */
  const HOME_SENTINEL = '\\\\dsh-wsl-home\\';
  const rootCrumb = { name: COMPUTER_LABEL, path: COMPUTER_ROOT, hidden: false };
  const distroLabel = (distro) => `${distro} (WSL)`;

  /** Drive letters that answer within a short deadline (an empty card reader or a dead share must not stall the list). */
  async function listDrives(signal) {
    const probe = async (letter) => {
      const root = `${letter}:\\`;
      let timer;
      try {
        await Promise.race([
          nodeStat(root),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), 1500);
            timer.unref?.();
          }),
        ]);
        return { name: `${letter}:`, path: root, hidden: false };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };
    const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
    const drives = (await Promise.all(letters.map(probe))).filter(Boolean);
    signal?.throwIfAborted();
    return drives;
  }

  /** The virtual "This PC" level: every Windows drive plus every WSL distribution. */
  async function listComputer(signal) {
    const [drives, distros] = await Promise.all([listDrives(signal), listDistros().catch(() => [])]);
    signal?.throwIfAborted();
    return {
      path: COMPUTER_ROOT,
      home: HOME_SENTINEL,
      crumbs: [rootCrumb],
      entries: [
        ...drives,
        ...distros.map((distro) => ({ name: distroLabel(distro), path: uncFromLinux(distro, '/'), hidden: false })),
      ],
      truncated: false,
    };
  }

  async function listWsl(path, signal) {
    const home = HOME_SENTINEL;
    const parsed = noteDistro(parseWslUnc(path));
    const target = uncFromLinux(parsed.distro, parsed.linuxPath);
    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (error) {
      signal?.throwIfAborted();
      throw failure('directory-unreadable', target, `cannot list ${target}: ${error?.message ?? error}`);
    }
    const entries = [];
    let truncated = false;
    for (const dirent of dirents.sort(sortByName)) {
      signal?.throwIfAborted();
      let isDirectory = dirent.isDirectory();
      if (!isDirectory && dirent.isSymbolicLink()) {
        try {
          isDirectory = (await nodeStat(join(target, dirent.name))).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      if (!isDirectory) continue;
      if (entries.length === maxEntries) {
        truncated = true;
        break;
      }
      entries.push({ name: dirent.name, path: join(target, dirent.name), hidden: dirent.name.startsWith('.') });
    }
    const crumbs = [
      rootCrumb,
      { name: distroLabel(parsed.distro), path: uncFromLinux(parsed.distro, '/'), hidden: false },
    ];
    let walked = '';
    for (const segment of parsed.linuxPath.split('/').filter(Boolean)) {
      walked += `/${segment}`;
      crumbs.push({ name: segment, path: uncFromLinux(parsed.distro, walked), hidden: false });
    }
    return { path: target, home, crumbs, entries, truncated };
  }

  async function createWsl(path, folder) {
    const parsed = noteDistro(parseWslUnc(path));
    if (parsed === undefined) {
      throw failure('directory-create-failed', path, `cannot create under "${path}": pick a distribution first`);
    }
    const parent = uncFromLinux(parsed.distro, parsed.linuxPath);
    if (folder.trim() === '' || folder === '.' || folder === '..' || /[/\\]/.test(folder)) {
      throw failure('directory-create-failed', join(parent, folder), `"${folder}" is not a single path segment`);
    }
    const target = join(parent, folder);
    try {
      await mkdir(target);
      return target;
    } catch (error) {
      if (error?.code === 'EEXIST') throw failure('directory-exists', target, `${target} already exists`);
      throw failure('directory-create-failed', target, `cannot create ${target}: ${error?.message ?? error}`);
    }
  }

  patchObject(ctx, capability, 'directoryPicker capability', (replace) => {
    replace('list', async (path, signal) => {
      if (path === COMPUTER_ROOT || isWslRoot(path)) return listComputer(signal);
      if (typeof path === 'string' && parseWslUnc(path) !== undefined) return listWsl(path, signal);
      const result = await originalList(path, signal);
      // Put "This PC" in front of the drive root and stop "Home" from hiding the ancestors.
      return { ...result, home: HOME_SENTINEL, crumbs: [rootCrumb, ...result.crumbs] };
    });
    replace('createDirectory', (path, folder) => {
      if (path === COMPUTER_ROOT) {
        throw failure('directory-create-failed', path, `cannot create "${folder}" here: open a drive or distribution first`);
      }
      return typeof path === 'string' && parseWslUnc(path) !== undefined
        ? createWsl(path, folder)
        : originalCreate(path, folder);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Filesystem                                                          */
/* ------------------------------------------------------------------ */

const normalizeEol = (text) => text.replaceAll('\r\n', '\n');
const detectEol = (raw) => {
  const sample = raw.slice(0, 4096);
  const crlf = sample.split('\r\n').length - 1;
  return crlf > sample.split('\n').length - 1 - crlf ? 'CRLF' : 'LF';
};
const restoreEol = (text, eol) => (eol === 'LF' ? text : normalizeEol(text).split('\n').join('\r\n'));
const isWslTarget = (target) => parseWslUnc(String(target?.targetKey ?? '')) !== undefined;

function patchFileSystem(ctx) {
  const fs = ctx.fs;
  let FsError;
  const probeTarget = { targetKey: join(tmpdir(), `.dsh-wsl-probe-${process.pid}`), displayPath: 'probe' };
  fs.readText(probeTarget).catch((error) => {
    if (typeof error?.code === 'string') FsError = error.constructor;
  });
  const fail = (message, code, cause) => {
    if (FsError !== undefined) return new FsError(message, code, cause === undefined ? undefined : { cause });
    return Object.assign(new Error(message), { code });
  };

  const locked = (target, op) =>
    typeof fs.withLock === 'function' ? fs.withLock(target.targetKey, op) : op();
  const fenced = async (target, policy) =>
    typeof fs.checkedTarget === 'function' ? fs.checkedTarget(target, policy) : target;

  async function diffBasis(path) {
    try {
      const info = await nodeStat(path);
      if (!info.isFile() || info.size >= MAX_DIFF_BASIS_BYTES) return null;
      const handle = await open(path, 'r');
      try {
        const buffer = await handle.readFile();
        if (buffer.includes(0)) return null;
        return normalizeEol(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  /** In-place write: keeps mode, owner and symlinks, which a temp-file rename would lose over 9P. */
  async function writeInPlace(target, content, exclusive, signal) {
    signal?.throwIfAborted?.();
    try {
      await mkdir(dirname(target.targetKey), { recursive: true });
      const handle = await open(target.targetKey, exclusive ? 'wx' : 'w');
      try {
        await handle.writeFile(content, { encoding: 'utf8' });
        await handle.sync().catch(() => {});
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error?.code === 'EEXIST' && exclusive) {
        throw fail(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED');
      }
      if (error?.name === 'AbortError') throw fail('write aborted', 'FS_ABORTED');
      throw fail(`cannot write "${target.displayPath}": ${error?.message ?? error}`, 'FS_IO_ERROR', error);
    }
  }

  const versionAfter = (after, target) => after?.version ?? `missing:${target.targetKey}`;

  async function writeWsl(target, content, expected, signal, policy) {
    const checked = await fenced(target, policy);
    return locked(checked, async () => {
      const existing = await fs.stat(checked);
      if (existing && existing.type !== 'file') {
        throw fail(`cannot write "${checked.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!existing) throw fail(`cannot write "${checked.displayPath}": file no longer exists`, 'FS_STALE_VERSION');
        if (existing.version !== expected.version) {
          throw fail(`cannot write "${checked.displayPath}": file changed since it was read`, 'FS_STALE_VERSION');
        }
      } else if (expected?.kind === 'createIfAbsent' && existing) {
        throw fail(`cannot overwrite existing "${checked.displayPath}" without reading it first`, 'FS_NOT_OBSERVED');
      }
      const before = existing && Buffer.byteLength(content, 'utf8') < MAX_DIFF_BASIS_BYTES ? await diffBasis(checked.targetKey) : null;
      await writeInPlace(checked, content, expected?.kind === 'createIfAbsent', signal);
      const after = await fs.stat(checked);
      return {
        operation: existing ? 'update' : 'create',
        version: versionAfter(after, checked),
        before,
        after: normalizeEol(content),
      };
    });
  }

  async function editWsl(target, edit, expected, signal, policy) {
    const checked = await fenced(target, policy);
    return locked(checked, async () => {
      const existing = await fs.stat(checked);
      const changed = () => fail(`cannot edit "${checked.displayPath}": file changed since it was read`, 'FS_STALE_VERSION');
      if (!existing) throw changed();
      if (existing.type !== 'file') {
        throw fail(`cannot edit "${checked.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
      }
      if (expected && existing.version !== expected.version) throw changed();
      signal?.throwIfAborted?.();
      const handle = await open(checked.targetKey, 'r');
      let buffer;
      try {
        buffer = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (buffer.includes(0)) throw fail(`cannot edit "${checked.displayPath}": binary file`, 'FS_NOT_TEXT');
      let raw;
      try {
        raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        throw fail(`cannot edit "${checked.displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT');
      }
      const eol = detectEol(raw);
      const original = normalizeEol(raw);
      const oldText = normalizeEol(edit.oldString ?? '');
      if (oldText.length === 0) throw fail('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND');
      const newText = normalizeEol(edit.newString ?? '');
      const count = original.split(oldText).length - 1;
      if (count === 0) throw fail(`old_string was not found in "${checked.displayPath}"`, 'FS_EDIT_NOT_FOUND');
      if (!edit.replaceAll && count > 1) {
        throw fail(
          `old_string matched ${count} times in "${checked.displayPath}"; provide a more specific old_string or set replace_all to true`,
          'FS_AMBIGUOUS_EDIT',
        );
      }
      const edited = original.split(oldText).join(newText);
      await writeInPlace(checked, restoreEol(edited, eol), false, signal);
      const after = await fs.stat(checked);
      return { version: versionAfter(after, checked), before: original, after: edited };
    });
  }

  /** Polling watcher: inotify does not cross the 9P share and chokidar fails on UNC roots. */
  async function watchWsl(target, changed, signal) {
    signal?.throwIfAborted?.();
    let last = (await fs.stat(target, signal))?.version;
    const timer = setInterval(async () => {
      try {
        const current = (await fs.stat(target))?.version;
        if (current !== last) {
          last = current;
          changed();
        }
      } catch (error) {
        changed(error instanceof Error ? error : new Error(String(error)));
      }
    }, 2000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  const original = {
    resolve: fs.resolve.bind(fs),
    lstat: fs.lstat.bind(fs),
    writeText: fs.writeText.bind(fs),
    editText: fs.editText.bind(fs),
    watch: fs.watch.bind(fs),
  };
  /** `/home/me/x` or `/mnt/c/x` typed against a WSL base directory becomes a Windows-openable path. */
  const mapped = (path, opts) => mapPosixPath(opts?.cwd ?? fs.config?.cwd, path);

  patchObject(ctx, fs, 'fs', (replace) => {
    replace('resolve', async (path, opts) => {
      const result = await original.resolve(mapped(path, opts), opts);
      noteDistro(parseWslUnc(String(result.targetKey)));
      return result;
    });
    replace('lstat', (path, opts, signal) => original.lstat(mapped(path, opts), opts, signal));
    replace('writeText', (target, content, expected, signal, policy) =>
      isWslTarget(target)
        ? writeWsl(target, content, expected, signal, policy)
        : original.writeText(target, content, expected, signal, policy),
    );
    replace('editText', (target, edit, expected, signal, policy) =>
      isWslTarget(target)
        ? editWsl(target, edit, expected, signal, policy)
        : original.editText(target, edit, expected, signal, policy),
    );
    replace('watch', (target, changed, signal) =>
      isWslTarget(target) ? watchWsl(target, changed, signal) : original.watch(target, changed, signal),
    );
  });
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

const ESCALATION_MESSAGE =
  'WSL commands run outside the Windows sandbox and need explicit approval. ' +
  'Retry this call with sandbox_permissions set to "danger-full-access" and a one-sentence justification.';

/** Distro and Linux directory a spec should run in, or undefined for a normal Windows command. */
function wslTargetOf(spec) {
  const workdir = spec?.workdir;
  const parsed = noteDistro(parseWslUnc(workdir));
  if (parsed !== undefined) return parsed;
  if (typeof workdir === 'string' && /^\/(?!\/)/.test(workdir) && lastDistro !== undefined) {
    return { distro: lastDistro, linuxPath: workdir.replace(/\/+$/, '') || '/' };
  }
  return undefined;
}

function patchShell(ctx) {
  const shell = ctx.shell;
  if (typeof shell.argv !== 'function' || typeof shell.spawnSpec !== 'function') {
    ctx.logger?.('dsh-wsl').warn?.('ctx.shell is not a pwsh executor; WSL commands are not routed.');
    return;
  }
  const original = {
    argv: shell.argv.bind(shell),
    spawnSpec: shell.spawnSpec.bind(shell),
    execute: shell.execute.bind(shell),
  };
  patchObject(ctx, shell, 'shell', (replace) => {
    replace('argv', (spec) => {
      const target = wslTargetOf(spec);
      return target === undefined ? original.argv(spec) : buildWslArgv(target, spec.command);
    });
    // wsl.exe is a Windows process; give it a real Windows cwd and pass the Linux one via --cd.
    replace('spawnSpec', (spec, stdoutMaxBytes, signal, argv) =>
      wslTargetOf(spec) === undefined
        ? original.spawnSpec(spec, stdoutMaxBytes, signal, argv)
        : original.spawnSpec({ ...spec, workdir: SAFE_CWD }, stdoutMaxBytes, signal, argv),
    );
    replace('execute', async (spec) => {
      if (wslTargetOf(spec) !== undefined) {
        const mode = spec.sandboxPolicy?.mode;
        if (mode !== undefined && mode !== 'danger-full-access') throw new Error(ESCALATION_MESSAGE);
      }
      return original.execute(spec);
    });
  });
}

function addPromptSection(ctx) {
  const prompt = ctx.get?.('systemPrompt');
  if (prompt?.section === undefined) return;
  let order;
  try {
    order = prompt.getSectionOrder('TOOL_PWSH');
  } catch {
    order = undefined;
  }
  prompt.section({
    name: 'tool:pwsh:wsl',
    ...(order === undefined ? {} : { order }),
    text:
      'WSL workspaces: when the workspace or `workdir` is a `\\\\wsl.localhost\\<distro>\\...` path, ' +
      'the `pwsh` tool runs `command` with bash inside that distribution, in the matching Linux directory. ' +
      'Write bash, not PowerShell. File tools take either the UNC path or the Linux path (`/home/me/x`). ' +
      'These commands are not sandboxed, so each one needs `sandbox_permissions: "danger-full-access"` ' +
      'with a justification unless the session already has full access. Windows drives appear as `/mnt/c`.',
  });
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

/**
 * Cordis entry. Each wrapper activates independently once its service exists,
 * so a missing picker (or a non-pwsh shell) does not disable the others.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 */
export function apply(ctx) {
  if (process.platform !== 'win32') return;
  ctx.inject(['fs'], (inner) => patchFileSystem(inner));
  ctx.inject(['shell'], (inner) => {
    patchShell(inner);
    addPromptSection(inner);
  });
  ctx.inject(['directoryPicker'], (inner) => patchDirectoryPicker(inner));
}

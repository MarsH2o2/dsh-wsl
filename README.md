# dsh-wsl

English | [简体中文](README.zh-CN.md)

WSL workspaces for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) on Windows.

A WSL workspace is addressed by its Windows UNC path, for example `\\wsl.localhost\Ubuntu\home\me\proj`. That spelling already passes DSH's "fully qualified absolute path" checks, so DSH can open the folder directly. What it cannot do on its own is browse the distro, write files over the 9P share, or run commands inside Linux. This plugin fills those three gaps.

## Features

| Area | What dsh-wsl does |
| --- | --- |
| Folder picker | Adds a "This PC" level that lists Windows drives and installed WSL distributions. You can browse Linux folders and create new ones from the in-app picker. |
| File I/O (`ctx.fs`) | Writes and edits files in place, without hard links or Windows DACL calls (neither works on the 9P-backed UNC share). Keeps the original line endings (LF or CRLF). Watches files by polling every 2 seconds, because inotify does not cross 9P. |
| Path mapping | Linux-style paths typed by the model are mapped for the Windows filesystem: `/mnt/c/x` becomes `C:\x`, and any other `/x` becomes `\\wsl.localhost\<distro>\x`. |
| Shell (`ctx.shell`) | When the workspace or `workdir` is a WSL path, the `pwsh` tool runs the command with `bash -lc` inside that distro, in the matching Linux directory, through `wsl.exe`. The command is passed as base64, so quoting, newlines and non-ASCII text survive the Windows command line. |
| Prompt | Adds a `tool:pwsh:wsl` section to the system prompt so the model knows to write bash and to use Linux or UNC paths. |

Every wrapper only changes behaviour for WSL paths. All other paths go through DSH's original implementation. Each wrapper also activates on its own, so a missing picker or a non-pwsh shell does not disable the others. On dispose, the original methods are restored.

## Requirements

- Windows with WSL 2 and at least one installed distribution (`wsl -l -q` should list it).
- DeepSeek Harness desktop with the cordis plugin profile (`~/.dsh/profiles/desktop/cordis.patch.yml`).
- The in-app browse directory picker packages:
  - `@deepseek-ai/dsh-host-directory-picker-browse`
  - `@deepseek-ai/dsh-client-ui-directory-picker-browse`

The plugin does nothing on non-Windows platforms (`process.platform !== 'win32'`). It imports no DSH package, so the folder can live outside the DSH install.

## Installation

1. Put this repository on the Windows side, for example:

   ```powershell
   git clone <this-repo-url> C:\Users\<you>\Documents\deepseek-harness\dsh-wsl
   ```

2. Open `wsl.patch.yml` and copy its rows into `~/.dsh/profiles/desktop/cordis.patch.yml` (a top-level YAML array; keep your existing rows).

3. Change the `file:///` URL of the `dsh-wsl` row so it points to your copy of `lib/index.js`:

   ```yaml
   - id: directory-picker
     disabled: true

   - insert:
       - id: directory-picker-browse
         name: '@deepseek-ai/dsh-host-directory-picker-browse'
       - id: directory-picker-browse-ui
         name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
       - id: dsh-wsl
         name: file:///C:/Users/<you>/Documents/deepseek-harness/dsh-wsl/lib/index.js
   ```

   What these rows do:
   - Disable the adaptive picker, which mounts the native OS dialog on Windows.
   - Mount the in-app browse picker, which dsh-wsl extends with a WSL view.
   - Load the plugin.

4. Restart DeepSeek Harness.

To uninstall, delete those rows and restart.

## Usage

1. In the folder picker, go to the top level ("This PC" or "此电脑"). You will see your drives and your distributions, shown as `Ubuntu (WSL)`.
2. Open a distribution, browse to your project and select it. You can also create a new folder there.
3. Work as usual. File tools accept the UNC path or the Linux path (`/home/me/x`). The `pwsh` tool runs bash inside the distro.

### Approval for WSL commands

`wsl.exe` runs outside the Windows sandbox. If the session sandbox is not `danger-full-access`, a WSL command is rejected with a message asking the caller to retry with `sandbox_permissions: "danger-full-access"` and a one-sentence justification. In a session that already has full access, no extra step is needed.

## How it works

```
lib/
├── index.js      cordis entry: wraps ctx.directoryPicker, ctx.fs and ctx.shell
└── wsl-path.js   UNC parsing, POSIX path mapping, wsl.exe argv, distro listing
wsl.patch.yml     plugin profile rows to merge into cordis.patch.yml
```

- `parseWslUnc` accepts `\\wsl.localhost\<distro>\...` and `\\wsl$\<distro>\...`, with either slash style.
- `listDistros` runs `wsl.exe -l -q`, decodes its UTF-16LE output, skips `docker-desktop*` helper distros and caches the result for 5 seconds.
- Shell commands are run as `wsl.exe -d <distro> --cd <linux path> -e bash -lc 'eval "$(printf %s "$0" | base64 -d)"' <base64 command>`.
- If `workdir` is a POSIX-rooted path with no distro, the most recently used distro is assumed.

## Limitations

- Windows only.
- The picker lists at most 1000 sub-folders per directory and marks the list as truncated beyond that.
- File watching is polling-based (2 second interval), not event-based.
- Writes are in place rather than temp-file plus rename, so they are not atomic.
- `docker-desktop` helper distros are hidden from the picker.

## Troubleshooting

- **"directoryPicker is ... not browse"** in the log: the adaptive picker is still active. Make sure the `directory-picker` row is disabled and the browse picker rows are present.
- **No distributions listed**: run `wsl -l -q` in a terminal. If that fails, WSL is not installed or not started.
- **Plugin not loaded**: check that the `file:///` URL in the `dsh-wsl` row points to an existing `lib/index.js`, using forward slashes.
- **WSL commands rejected**: retry with `sandbox_permissions: "danger-full-access"`, or run the session with full access.

## License

The bundled [LICENSE](LICENSE) file is [Apache License 2.0](LICENSE). Note that `package.json` currently declares `MIT`; reconcile these files before publishing a release.

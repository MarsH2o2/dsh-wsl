# dsh-wsl

[English](README.md) | 简体中文

为 Windows 上的 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）提供 WSL 工作区支持。

WSL 工作区使用 Windows UNC 路径表示，例如 `\\wsl.localhost\Ubuntu\home\me\proj`。这种写法本身就满足 DSH 对“完整绝对路径”的检查，所以 DSH 可以直接打开该目录。但 DSH 自己做不到的有三件事：浏览发行版目录、通过 9P 共享写文件、在 Linux 内执行命令。本插件补上这三块。

## 功能

| 模块 | dsh-wsl 的处理 |
| --- | --- |
| 文件夹选择器 | 增加“此电脑”层级，列出 Windows 盘符和已安装的 WSL 发行版。可在应用内选择器里浏览 Linux 目录并新建文件夹。 |
| 文件读写（`ctx.fs`） | 原地写入和编辑文件，不使用硬链接和 Windows DACL 调用（这两者在基于 9P 的 UNC 共享上都不可用）。保留原有换行符（LF 或 CRLF）。由于 inotify 无法穿过 9P，文件监听改为每 2 秒轮询一次。 |
| 路径映射 | 把模型输入的 Linux 风格路径映射为 Windows 可打开的路径：`/mnt/c/x` 变为 `C:\x`，其他 `/x` 变为 `\\wsl.localhost\<发行版>\x`。 |
| Shell（`ctx.shell`） | 当工作区或 `workdir` 是 WSL 路径时，`pwsh` 工具会通过 `wsl.exe` 在对应发行版和对应 Linux 目录中用 `bash -lc` 执行命令。命令以 base64 传递，因此引号、换行和非 ASCII 文本都不会被 Windows 命令行破坏。 |
| 提示词 | 在系统提示词中加入 `tool:pwsh:wsl` 段落，告诉模型要写 bash，并使用 Linux 或 UNC 路径。 |

所有封装都只改变 WSL 路径的行为，其他路径仍走 DSH 原有实现。各封装独立生效，缺少选择器或 shell 不是 pwsh 时，不影响其他部分。插件卸载（dispose）时会恢复原方法。

## 环境要求

- 已安装 WSL 2 和至少一个发行版的 Windows（`wsl -l -q` 能列出）。
- 使用 cordis 插件配置的 DeepSeek Harness 桌面版（`~/.dsh/profiles/desktop/cordis.patch.yml`）。
- 应用内浏览式目录选择器相关包：
  - `@deepseek-ai/dsh-host-directory-picker-browse`
  - `@deepseek-ai/dsh-client-ui-directory-picker-browse`

在非 Windows 平台上插件不会做任何事（`process.platform !== 'win32'`）。插件不引入任何 DSH 包，所以目录可以放在 DSH 安装目录之外。

## 安装

1. 把本仓库放在 Windows 一侧，例如：

   ```powershell
   git clone <本仓库地址> C:\Users\<你的用户名>\Documents\deepseek-harness\dsh-wsl
   ```

2. 打开 `wsl.patch.yml`，把其中的条目合并到 `~/.dsh/profiles/desktop/cordis.patch.yml`（顶层是 YAML 数组，保留已有条目）。

3. 修改 `dsh-wsl` 条目里的 `file:///` 地址，指向你本机的 `lib/index.js`：

   ```yaml
   - id: directory-picker
     disabled: true

   - insert:
       - id: directory-picker-browse
         name: '@deepseek-ai/dsh-host-directory-picker-browse'
       - id: directory-picker-browse-ui
         name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
       - id: dsh-wsl
         name: file:///C:/Users/<你的用户名>/Documents/deepseek-harness/dsh-wsl/lib/index.js
   ```

   这些条目的作用：
   - 禁用自适应选择器（它在 Windows 上会调用系统原生对话框）。
   - 挂载应用内浏览式选择器，由 dsh-wsl 为它增加 WSL 视图。
   - 加载本插件。

4. 重启 DeepSeek Harness。

卸载时删除这些条目并重启即可。

## 使用

1. 在文件夹选择器中回到最顶层（“此电脑”或 “This PC”），可以看到各个盘符和发行版，发行版显示为 `Ubuntu (WSL)`。
2. 进入某个发行版，浏览到项目目录并选中。也可以在此新建文件夹。
3. 之后照常使用。文件工具既接受 UNC 路径，也接受 Linux 路径（`/home/me/x`）。`pwsh` 工具会在发行版内运行 bash。

### WSL 命令的授权

`wsl.exe` 运行在 Windows 沙箱之外。如果会话沙箱不是 `danger-full-access`，WSL 命令会被拒绝，并提示以 `sandbox_permissions: "danger-full-access"` 加一句理由重试。如果会话本来就是完全访问权限，则无需额外操作。

## 工作原理

```
lib/
├── index.js      cordis 入口：封装 ctx.directoryPicker、ctx.fs、ctx.shell
└── wsl-path.js   UNC 解析、POSIX 路径映射、wsl.exe 参数、发行版列表
wsl.patch.yml     需合并到 cordis.patch.yml 的插件配置条目
```

- `parseWslUnc` 同时接受 `\\wsl.localhost\<发行版>\...` 和 `\\wsl$\<发行版>\...`，正反斜杠均可。
- `listDistros` 执行 `wsl.exe -l -q`，按 UTF-16LE 解码输出，跳过 `docker-desktop*` 辅助发行版，并缓存 5 秒。
- Shell 命令的执行形式为：`wsl.exe -d <发行版> --cd <Linux 路径> -e bash -lc 'eval "$(printf %s "$0" | base64 -d)"' <base64 命令>`。
- 如果 `workdir` 是不带发行版的 POSIX 根路径，则假定使用最近一次用过的发行版。

## 限制

- 仅支持 Windows。
- 选择器每个目录最多列出 1000 个子文件夹，超出后标记为已截断。
- 文件监听基于轮询（间隔 2 秒），不是事件驱动。
- 写入是原地写，而不是临时文件加重命名，因此不是原子操作。
- 选择器中隐藏 `docker-desktop` 辅助发行版。

## 故障排查

- **日志出现 “directoryPicker is ... not browse”**：自适应选择器仍在生效。确认 `directory-picker` 条目已禁用，且浏览式选择器条目已添加。
- **没有列出任何发行版**：在终端运行 `wsl -l -q`。若失败，说明 WSL 未安装或未启动。
- **插件没有加载**：检查 `dsh-wsl` 条目里的 `file:///` 地址是否指向真实存在的 `lib/index.js`，并使用正斜杠。
- **WSL 命令被拒绝**：以 `sandbox_permissions: "danger-full-access"` 重试，或让会话使用完全访问权限。

## 许可证

随仓库附带的 [LICENSE](LICENSE) 文件为 [Apache License 2.0](LICENSE)。注意：`package.json` 当前声明为 `MIT`；发布版本前应统一这两处许可证信息。

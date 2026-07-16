# Scripty

> ZTools 中的本地轻量脚本任务管理器。

Scripty 用于集中管理、运行和定时调度当前设备上的脚本。脚本源码、任务配置、环境变量、运行记录和日志均保存在本地，不依赖远程服务。

当前版本：**1.0.0（首个 MVP）**

## 功能

- 新建、导入、编辑和删除真实目录树中的托管脚本
- 在应用数据根统一管理 Node `package.json`/`node_modules` 与 Python `requirements.txt`/`.venv` 依赖环境
- 管理 JavaScript、Python、PowerShell 和 Shell 任务
- 配置参数、工作目录、超时、并发策略和五段 Cron
- 手动运行、停止任务并实时查看 stdout/stderr
- 查看运行状态、退出码、耗时、错误摘要和分块历史日志
- 管理全局与任务级环境变量，支持 `.env` 导入和导出
- 默认遮罩敏感变量，并在写入实时与历史日志前脱敏
- 按任务、数量或保留天数清理运行历史和日志
- 通过版本化 ZIP 包预览、合并或覆盖恢复本地数据
- 提供“任务库”“运行指定任务”“运行中任务”ZTools 快捷指令
- 跟随 ZTools 亮色、暗色和主题色设置

## 重要说明

### 调度生命周期

Cron **仅在 Scripty 插件进程存活期间生效**。隐藏窗口或将插件退到后台不会暂停调度；完全退出插件或 ZTools 后，调度停止。Scripty 不是系统级常驻服务，也不会承诺插件关闭后的后台执行。

### 数据与敏感信息

- 所有数据默认保存在 `<ZTools userData>/scripty`。
- 环境变量值以本地数据形式保存，不等同于系统密钥库保护。
- 敏感值默认不显示、不进入普通导出，并在日志写入前遮罩。
- 只有用户显式选择并再次确认后，备份包才会包含敏感值；这类 ZIP 包含本地明文敏感信息，请妥善保管。
- 导入的脚本会复制到托管目录；之后修改托管副本不会改动原始文件。

本地目录布局：

```text
<ZTools userData>/scripty/
├── data/              # 脚本、目录、依赖、任务、环境变量、设置和运行记录元数据
├── scripts/           # 应用托管的真实脚本目录树
├── package.json       # Scripty 生成的 Node 直接依赖清单
├── node_modules/      # 所有脚本共享的应用本地 Node 依赖环境
├── requirements.txt  # Scripty 生成的 Python 直接依赖清单
├── .venv/             # 所有 Python 脚本共享的虚拟环境
├── logs/              # 独立运行日志
└── backups/           # 覆盖恢复前的自动备份
```

## 支持范围

MVP 优先支持 Windows，并保持执行层可扩展到 macOS 和 Linux。Scripty 不负责安装 Node.js、Python、PowerShell 或 Shell 运行时，请先在本机安装所需解释器。Node 和 Python 的直接依赖在独立“依赖”页维护，并统一安装到 `<userData>/scripty/node_modules` 与 `<userData>/scripty/.venv`；脚本运行不会依赖全局第三方包。解释器使用显式绝对路径时始终以该路径为准；使用裸命令时会先从 ZTools 宿主进程的 `PATH` 解析。
在 macOS 上，如果 JavaScript 任务使用 `node` 且图形界面的 `PATH` 中没有 Node，还会尝试 `$MISE_DATA_DIR`、`XDG_DATA_HOME/mise` 或 `~/.local/share/mise` 下的标准 Node 安装。

mise 自动发现优先使用 `installs/node/latest/bin/node` 指向的独立 Node 可执行文件；若没有该别名，则兼容回退到 `shims/node`。该过程不会执行 `mise`，也不会加载 `.zshrc` 等 Shell 配置。自动解析出的设备路径不会写入任务或备份。若使用其他目录且该目录没有进入 ZTools 的环境变量，请在“设置”或任务中手动配置绝对 Node 路径。

当前不包含：

- 多设备自动同步、用户系统或远程访问
- Docker、分布式执行节点或系统级守护进程
- Git 仓库订阅、远程脚本自动更新或在线脚本市场
- 运行时自动安装
- 青龙面板 API 兼容

## 使用

1. 通过“任务库”或“Scripty”指令进入插件。
2. 在“脚本”中新建脚本，或选择本地文件导入托管副本。
3. 在“设置”中确认相应语言的解释器，并在“依赖”页新增、修改或删除直接依赖后同步 Node/Python 共享环境。
4. 在“任务”中关联脚本，并配置参数、目录、超时、并发和可选 Cron。
5. 手动运行任务，或启用带 Cron 的任务。
6. 在“运行中”查看实时输出，在“运行历史”查看结果和日志。
7. 在“备份”中导出迁移包；导入前可预览变更并选择合并或覆盖。

任务参数会以结构化参数数组传给 `child_process.spawn`，默认使用 `shell: false`，不会把任务名称或参数拼接成 Shell 命令。

## 开发

### 环境要求

- Node.js 18 或更高版本
- npm
- ZTools（进行宿主集成和实际插件验证时）

### 安装依赖

```bash
npm ci
```

### 启动开发服务器

```bash
npm run dev
```

开发入口为 `http://localhost:5173`，由 `public/plugin.json` 的 `development.main` 提供给 ZTools。

### 构建

```bash
npm run check
```

该命令依次运行 Vue TypeScript 检查和 Vite 生产构建。构建产物输出到 `dist/`。

也可单独执行：

```bash
npm run build
```

## 产出与安装发布制品

1. 执行 `npm ci && npm run release`。
2. 使用 `npm run release:verify` 校验生产清单、资源、自包含 preload、普通 ZIP 与文件哈希。
3. 将 `release/scripty-1.0.0/` 作为完整插件目录导入 ZTools，并通过“任务库”指令进入。
4. 首次使用时确认解释器解析结果和调度生命周期提示；macOS 标准 mise Node 通常无需手动填写版本路径。

`dist/` 只是 Vite 中间构建，其中保留开发用文件，不是正式制品。正式目录仅包含 `index.html`、生产 `plugin.json`、`logo.png`、前端资源和已打包依赖的 `preload/`。`release/scripty-1.0.0.zip` 是内容相同、可重复生成的普通传输 ZIP；本地资料尚未证明 ZTools 支持直接导入该 ZIP 或要求 `.upx`，因此应先解压，再按完整目录导入。不要只复制 `index.html`。

在仓库外的全新源码副本中执行两次完整安装、构建与哈希一致性检查：

```bash
npm run verify:clean
```

该命令会在仓库外的全新源码副本中执行两次完整安装与构建，校验产物 ZIP 与文件哈希的一致性。Windows/ZTools 对最终 SHA-256 制品的宿主安装确认单独记录在发布说明中。

## 备份兼容性

Scripty 1.0.0 当前导出备份协议 `1.1`，并继续兼容导入旧版 `1.0` 包。导入时会校验格式版本、清单、受控路径、文件数量与大小、SHA-256、实体关系和脚本内容哈希；`1.1` 额外保存真实目录树中的空目录和直接依赖声明，但不会打包 `node_modules` 或 `.venv`。合并导入按稳定 ID 更新；覆盖恢复会先自动备份当前数据。校验或事务失败时不会留下半导入状态。

## 项目结构

```text
.
├── public/
│   ├── logo.png
│   ├── plugin.json
│   └── preload/        # 文件、进程、调度、历史、环境和备份服务
├── src/
│   ├── components/     # 任务、脚本、运行、历史、环境、备份和设置视图
│   ├── types/          # 领域模型与受限 preload API 类型
│   ├── App.vue
│   ├── main.ts
│   └── plugin-entry.ts
├── RELEASE_NOTES.md
├── ROADMAP.md
└── package.json
```

## 发布说明

首个 MVP 的功能、限制和验证范围见 [RELEASE_NOTES.md](./RELEASE_NOTES.md)。

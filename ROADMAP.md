# Scripty Roadmap

## 1. 产品定位

Scripty 是运行在 ZTools 中的本地轻量脚本任务管理插件，目标是覆盖青龙面板最常用的个人场景：

- 集中管理本地脚本
- 手动或按 Cron 定时运行脚本
- 管理脚本所需的环境变量
- 查看任务状态、执行结果和历史日志
- 通过导出和导入完成备份、迁移与设备间转移

首个版本面向单机、单用户，不提供自动同步，不以复刻青龙面板全部能力为目标。

## 2. 范围边界

### 核心范围

- 脚本管理：新建、导入、编辑、删除、搜索、启用和禁用
- 任务调度：手动执行、Cron 表达式、下次运行时间、并发保护
- 运行管理：启动、停止、超时、退出码、耗时和状态
- 日志管理：实时输出、历史记录、错误查看、清理策略
- 环境变量：增删改查、启用和禁用、运行时注入、敏感值遮罩
- 本地数据：脚本源码、任务、环境变量、设置、运行记录和日志均保存在当前设备
- 数据迁移：提供版本化导出包和导入流程
- 基础设置：默认解释器、日志保留数量、任务超时和数据目录
- 组件体系：所有通用界面组件统一使用 `ztools-ui`

### 暂不纳入 MVP

- 多设备自动同步
- 多用户、登录、权限和远程访问
- Docker、容器编排和分布式执行节点
- Git 仓库订阅、远程脚本自动同步和 Webhook
- 在线脚本市场
- Python、Node.js 等运行时或依赖的自动安装
- 系统级常驻服务
- 青龙面板 API 兼容

这些能力应在核心执行与调度稳定后再评估，避免插件过早演变为完整运维平台。

## 3. 技术原则

- Vue 页面只负责展示和交互，文件系统、进程与调度能力统一放在 preload 服务中。
- 按钮、表单、输入框、选择器、对话框、通知、菜单、表格、空状态等通用组件统一使用 `ztools-ui`，不重复自研同类基础组件。
- 全局视觉变量和交互状态以 `ztools-ui` 的主题能力为基础，仅编写页面布局和业务态样式。
- 渲染进程不得直接拼接并执行 shell 命令；任务使用结构化的解释器、脚本路径和参数，通过 `spawn` 启动进程。
- 默认只执行用户明确创建或导入的本地脚本，不自动执行远程内容。
- 环境变量仅在任务进程中注入；日志输出时对已标记为敏感的信息进行遮罩。
- 数据写入采用临时文件加原子替换，避免异常退出造成配置损坏。
- 脚本源码由插件管理并存入本地数据目录；导入外部脚本后形成独立副本，不持续依赖原始文件路径。
- 导出包是跨设备迁移的唯一正式路径；导入前必须校验格式和版本，并由用户选择合并或覆盖策略。
- 调度必须以实测的 ZTools 生命周期为依据；若插件退出后无法继续运行，界面中必须明确说明“仅在插件存活期间调度”，不得承诺后台常驻。
- MVP 优先支持 Windows，并保持进程执行层可扩展到 macOS 和 Linux。

## 4. 里程碑

### M0：可行性验证与基础设计

目标：在开发正式功能前消除 ZTools 生命周期、进程控制、本地存储和 `ztools-ui` 接入的不确定性。

任务：

- [x] 验证插件窗口隐藏、退出和 ZTools 退出时 preload 的存活行为
- [x] 验证定时器在窗口隐藏后是否继续触发
- [x] 验证 Node 子进程的启动、实时输出、停止及父进程退出后的行为
- [x] 确认插件数据目录、托管脚本目录、日志目录和备份目录
- [x] 验证 `ztools-ui` 的安装、主题、暗色模式、弹窗、表单、通知和类型支持
- [x] 盘点 `ztools-ui` 可直接复用的组件，形成页面到组件的映射
- [x] 确定脚本、任务、环境变量、设置和运行记录的数据模型
- [x] 确定唯一 ID、时间字段、状态枚举和数据版本字段
- [x] 定义版本化导出包结构及导入兼容策略
- [x] 设计 preload API，避免向页面暴露通用命令执行和任意文件写入能力
- [x] 建立错误返回格式和运行状态流转规则

#### M0 验证记录

> 每项调研任务只有在实验条件、观察结果、结论和实现约束写入本节后才能勾选完成。

1. **Preload 生命周期（已验证，Windows 11 / ZTools，2026-07-11）**
   - 实验：preload 每秒向 `%TEMP%/scripty-preload-lifecycle.jsonl` 写入带 PID 的心跳，并记录 `onPluginEnter`、`onPluginOut(processExit)`、隐藏及退出请求。
   - 窗口隐藏：PID `24660` 在隐藏请求后继续写入至少 27 次心跳，PID 未变化。
   - 插件退到后台：`outPlugin(false)` 触发 `onPluginOut(false)`，preload 心跳继续。
   - 插件完全退出：`outPlugin(true)` 依次观察到 `onPluginOut(false)` 和 `onPluginOut(true)`；旧 preload PID `48048` 心跳停止，重新进入后产生新 PID。
   - ZTools 完全退出：退出前 preload PID `24660` 的心跳立即停止，5 秒后 ZTools 进程数为 0；重新启动宿主后进程恢复。
   - 结论：窗口隐藏和插件退到后台期间可以继续调度；插件进程被终止或 ZTools 退出后不能继续调度。MVP 必须明确为“仅在插件存活期间调度”。

2. **隐藏窗口后的定时器（已验证，2026-07-11）**
   - 实验：使用 preload 中的一秒 `setInterval` 心跳作为定时器探针。
   - 结果：`hide-window-requested` 发生后，同一 PID 连续写入 27 次心跳。
   - 结论：ZTools 主窗口隐藏不会暂停 preload 定时器。
   - 兼容性约束：ZTools preload 的 `setInterval` 返回浏览器计时器编号，不支持 Node `Timeout.unref()`；不得调用 `.unref()`。

3. **Node 子进程生命周期（已验证，Windows 11 / ZTools，2026-07-11）**
   - 实验：preload 使用 `spawn('node', ['-e', fixedScript], { shell: false, windowsHide: true })` 启动固定测试进程，分别监听 stdout、stderr、error 和 exit。
   - 启动与流输出：真实宿主中连续接收到 `tick:1` 至 `tick:41`，stderr 同步收到偶数 tick，证明可持续分流 stdout/stderr。
   - 主动停止：独立探针调用 `child.kill()` 后收到 `child-exit`，无残留进程。
   - 父进程退出：preload PID `24188` 被终止后，测试子 PID `26068` 不再存在。
   - 关键发现：Electron preload 中 `process.execPath` 指向 `ZTools.exe`，不是 Node；使用它会错误启动另一个 ZTools 实例。执行层必须使用明确配置或解析得到的解释器路径。
   - 结论：结构化 `spawn`、实时输出和主动停止可行；正式实现仍需针对会再派生后代进程的脚本实现 Windows 进程树清理。

4. **本地目录布局（已确认，2026-07-11）**
   - ZTools 只提供共享 `getPath('userData')`，未提供插件专属数据目录。
   - Scripty 根目录：`<userData>/scripty`；当前设备实测为 `C:\\Users\\A\\AppData\\Roaming\\ZTools\\scripty`。
   - 元数据目录：`data/`；托管脚本目录：`scripts/`；运行日志目录：`logs/`；备份目录：`backups/`。
   - 所有目录已在当前设备创建并核验；preload 只暴露固定目录布局，不允许页面指定任意写入目录。

5. **`ztools-ui` 核心能力（已验证，`ztools-ui@0.1.3` / ZTools / 2026-07-11）**
   - 安装与类型：完成全局插件注册和 `style.css` 导入；TypeScript 正确识别 `ZButton`、`ZInput`、`ZToast`、`ZConfirmDialog`、`useToast()`、`useZtoolsTheme()` 和 `applyTheme()`。
   - 依赖约束：发布包将 `vue-router` 标记为可选 peer dependency，但主入口静态导入它；未安装时 Vite 报 `useRoute is not exported by __vite-optional-peer-dep`。当前显式安装兼容的 `vue-router@^4.5.0` 后 `npm run build` 通过。
   - 亮色与主题：真实 ZTools 中 `useZtoolsTheme()` 返回 `isDark=false`、`primaryColor=purple`，表单值 `Scripty` 可正常双向绑定并提交。
   - 弹窗与通知：`ZConfirmDialog` 返回 `accepted=true`，随后 `ZToast` 成功显示 `success` 通知；事件由真实 preload PID `47824` 记录。
   - 暗色模式：通过 `applyTheme({ isDark: true, primaryColor: 'purple', ... })` 临时切换，下一渲染帧确认根元素包含 `dark` 类且 `ZInput` 已渲染；随后恢复原宿主主题。事件由真实 preload PID `32232` 记录。
   - 构建结果：`vue-tsc && vite build` 通过。结论是组件库可用于 MVP，但必须保留显式 `vue-router` 依赖，并统一从主入口注册主题和样式。

6. **`ztools-ui` 页面到组件映射（已盘点，`ztools-ui@0.1.3` / 2026-07-11）**
   - 公开基础组件共 26 类：`Pagination`、`Button`、`Checkbox`、`ColorPicker`、`Popover`、`Select`、`HotkeyInput`、`Input`、`Radio`、`Slider`、`Switch`、`Tag`、`Toast`、`ShortcutEditor`、`DetailPanel`、`AdaptiveIcon`、`CommandTag`、`FeatureCard`、`ConfirmDialog`、`TagDropdown`、`CommandCard`、`PluginDetail`、`Tabs`、`Drawer`、`Modal`、`ContextMenu`。
   - 公开 composables 共 6 类：`useColorScheme`、`useHistoryState`、`useZtoolsSubInput`、`useJumpFunction`、`useZtoolsTheme`、`useZtoolsOs`。

   | Scripty 页面或交互 | 直接复用组件 | 组合方式 |
   | --- | --- | --- |
   | 应用主导航 | `Tabs`、`AdaptiveIcon` | 任务、脚本、环境变量、运行历史、设置使用受控 Tabs；布局仅写业务 CSS |
   | 任务列表与搜索 | `Input`、`Select`、`Switch`、`Tag`、`Pagination`、`ContextMenu` | 原生语义化列表承载任务行；组件负责搜索、状态筛选、启停、状态标签、分页和行操作 |
   | 任务创建与编辑 | `Drawer`、`Input`、`Select`、`Switch`、`Checkbox`、`Radio`、`Button` | Drawer 承载长表单，原生 `form/label/fieldset` 负责结构；参数、解释器、超时和并发策略使用现有控件 |
   | 脚本导入与编辑 | `Modal`、`Button`、`Select`、`Input`、`ConfirmDialog` | 文件选择和语言配置使用现有控件；源码编辑区由业务代码编辑器承载 |
   | 运行中任务与实时日志 | `DetailPanel`、`Tag`、`Button`、`Tabs`、`Drawer` | DetailPanel 展示运行详情，Tag 展示状态，Button 停止任务，Tabs 分 stdout/stderr；日志视图为业务组件 |
   | 环境变量管理 | `Input`、`Switch`、`Checkbox`、`Tag`、`Drawer`、`ConfirmDialog` | 原生语义化列表 + 现有输入控件；敏感值查看、复制、导出均使用确认弹窗 |
   | 运行历史 | `Input`、`Select`、`Tag`、`Pagination`、`DetailPanel`、`Button` | 组合筛选条件、状态标签、分页、详情和快速重跑 |
   | Cron 配置 | `Input`、`Select`、`Radio`、`Popover`、`Tag` | 预设周期用 Select/Radio，表达式用 Input，预览用 Popover/Tag；解析与下次运行时间是业务逻辑 |
   | 设置 | `Tabs`、`Input`、`Select`、`Switch`、`Radio`、`HotkeyInput`、`ShortcutEditor`、`ColorPicker` | 默认解释器、超时、日志保留、并发策略、快捷键和主题设置均可组合现有控件 |
   | 导出与导入 | `Modal`、`Checkbox`、`Radio`、`ConfirmDialog`、`DetailPanel`、`Toast` | 选择导出范围、合并/覆盖模式、敏感值二次确认、变更预览和结果反馈 |
   | 全局反馈 | `Toast`、`ConfirmDialog`、`Modal`、`Popover` | Toast 用于瞬时结果，ConfirmDialog 用于危险操作，Modal 用于复杂流程，Popover 用于局部说明 |
   | ZTools 宿主集成 | `useZtoolsTheme`、`useColorScheme`、`useZtoolsOs`、`useZtoolsSubInput`、`useJumpFunction` | 跟随主题和平台，并复用宿主子输入框与跳转能力 |

   - 明确缺口：当前版本没有 `Table`、表单容器/校验器、空状态、代码编辑器、Cron 可视化编辑器、日期时间选择器、日志虚拟列表、树形视图、进度条或拆分面板。
   - 处理原则：表格需求优先用原生语义化 `table` 或列表组合现有控件；表单用原生 `form/label/fieldset`；空状态用页面业务文案与 `Button` 组合；代码编辑、日志分块/虚拟化和 Cron 预览属于 Scripty 业务组件，不复制通用输入、弹层或反馈组件。
   - 结论：M1-M6 的通用交互均可由 `ztools-ui` 覆盖或组合实现；新增代码只承担页面布局与领域专用视图。后续开发不得自研按钮、输入框、选择器、开关、标签、分页、菜单、抽屉、弹窗、确认框或通知。

7. **领域数据模型（已确定，2026-07-11）**

   **`Script` — 托管源码实体**

   | 字段 | 类型 | 说明 |
   | --- | --- | --- |
   | `id` | `string` | 稳定实体 ID |
   | `name` | `string` | 用户可见名称，不参与文件路径拼接 |
   | `managedFileName` | `string` | 仅保存受控文件名，不保存外部原始路径 |
   | `language` | `javascript \| python \| powershell \| shell` | 脚本语言 |
   | `contentHash` | `string` | 托管文件内容的 SHA-256，用于损坏和导入校验 |
   | `note` | `string` | 可选备注，持久化时使用空字符串而非缺失字段 |
   | `createdAt` / `updatedAt` | `string` | ISO 8601 UTC 时间 |

   - 源码正文存放于 `scripts/<managedFileName>`，不嵌入元数据 JSON；导入外部脚本时复制为独立托管副本。
   - `managedFileName` 由 ID 与受控扩展名生成，不能使用用户输入的名称。

   **`Task` — 可执行配置实体**

   | 字段 | 类型 | 说明 |
   | --- | --- | --- |
   | `id` / `name` / `note` | `string` | 稳定 ID、显示名称和备注 |
   | `scriptId` | `string` | 必须引用已存在的 `Script.id` |
   | `interpreter` | `{ kind, executable }` | 解释器类别与设备本地可执行文件/命令；执行时作为 `spawn` 的首个结构化参数 |
   | `args` | `string[]` | 参数数组，每项原样传入 `spawn`，不拼接 shell 字符串 |
   | `workingDirectory` | `string \| null` | 设备本地工作目录；`null` 使用托管脚本目录 |
   | `cron` | `string \| null` | 五段 Cron；`null` 表示仅手动运行 |
   | `timeoutMs` | `number \| null` | `null` 使用全局默认值 |
   | `enabled` | `boolean` | 是否允许调度；不影响手动编辑 |
   | `concurrency` | `{ policy, limit }` | 任务级并发配置；禁止重入时 `limit` 固定为 1 |
   | `createdAt` / `updatedAt` | `string` | ISO 8601 UTC 时间 |

   - `interpreter.executable`、`workingDirectory` 是设备相关字段，默认不进入跨设备导出包。
   - 删除被任务引用的脚本必须先阻止或由用户确认级联删除任务，不允许留下静默悬空引用。

   **`EnvironmentVariable` — 运行时变量实体**

   | 字段 | 类型 | 说明 |
   | --- | --- | --- |
   | `id` / `name` / `value` / `note` | `string` | ID、变量名、原始值和备注 |
   | `scope` | `global \| task` | 全局变量或任务级变量 |
   | `taskId` | `string \| null` | `scope=task` 时必须引用任务；全局时必须为 `null` |
   | `enabled` / `sensitive` | `boolean` | 是否注入及是否默认遮罩 |
   | `createdAt` / `updatedAt` | `string` | ISO 8601 UTC 时间 |

   - 同一作用域内变量名唯一；运行时按“系统环境 → 启用的全局变量 → 启用的任务变量”合并，同名时后者覆盖前者。
   - `sensitive` 控制展示、日志遮罩和导出确认，但当前 MVP 仍以本地明文数据保存，不宣称系统密钥库保护。

   **`Settings` — 单例设置实体**

   | 字段 | 类型 | 说明 |
   | --- | --- | --- |
   | `defaultTimeoutMs` | `number` | 默认任务超时 |
   | `defaultConcurrency` | `{ policy, limit }` | 新任务与未覆盖任务的并发默认值 |
   | `logRetention` | `{ maxRunsPerTask, maxAgeDays }` | 数量和天数联合保留策略；`null` 表示不启用对应限制 |
   | `defaultInterpreters` | `Record<language, string \| null>` | 各语言设备本地解释器配置 |
   | `defaultWorkingDirectory` | `string \| null` | 设备本地默认工作目录 |
   | `schedulerNoticeAcknowledged` | `boolean` | 是否已确认“仅插件存活期间调度”的限制 |
   | `updatedAt` | `string` | ISO 8601 UTC 时间 |

   - 设置是固定键单例，不使用实体数组；解释器路径和默认工作目录属于设备设置，导出时排除。

   **`RunRecord` — 不可变运行摘要实体**

   | 字段 | 类型 | 说明 |
   | --- | --- | --- |
   | `id` / `taskId` | `string` | 运行 ID 与来源任务 ID |
   | `taskNameSnapshot` / `scriptNameSnapshot` | `string` | 即使任务或脚本随后删除，历史仍可读 |
   | `trigger` | `manual \| cron \| retry` | 触发来源 |
   | `startedAt` / `finishedAt` | `string \| null` | UTC 时间；运行中 `finishedAt=null` |
   | `status` | `RunStatus` | 运行状态枚举在下一项统一定义 |
   | `exitCode` | `number \| null` | 无退出码的超时、停止、异常中断保持 `null` |
   | `durationMs` | `number \| null` | 结束后计算并持久化 |
   | `logFileName` | `string` | `logs/` 下的受控文件名，不保存绝对路径 |
   | `errorSummary` | `string \| null` | 已脱敏、长度受限的错误摘要 |

   - 每次执行创建独立日志文件；实时输出不写入元数据 JSON。
   - 运行记录创建后只允许补全结束字段和恢复异常中断状态，不随任务编辑回写历史快照。

   **`ExportManifest` — 导出包根清单**

   | 字段 | 类型 | 说明 |
   | --- | --- | --- |
   | `formatVersion` / `appVersion` | `string` | 导出协议版本与生成端应用版本 |
   | `exportedAt` | `string` | ISO 8601 UTC 时间 |
   | `entities` | `{ scripts, tasks, environments }` | 实体数量摘要 |
   | `options` | `{ includeEnvironmentValues, includeSensitiveValues }` | 本次导出范围及安全选择 |
   | `files` | `{ path, sha256, size }[]` | 包内每个受控相对路径的哈希和字节数 |

   - 清单不包含运行中状态、日志、绝对路径或解释器路径；包结构和兼容策略在后续独立任务中确定。

   **关系与持久化边界**

   - 关系：`Script 1 ── N Task`、`Task 1 ── N EnvironmentVariable(scope=task)`、`Task 1 ── N RunRecord`；全局环境变量不归属任务。
   - 元数据分别保存为 `data/scripts.json`、`tasks.json`、`environments.json`、`run-records.json` 和 `settings.json`，避免单个文件损坏扩大影响面。
   - 运行中进程句柄、实时日志缓冲、下次运行时间、解释器可用性和调度器状态均为运行时派生状态，不写入领域实体。
   - 结论：该模型覆盖 M1-M6 的创建、执行、调度、环境注入、历史和迁移关系，同时将源码、日志、设备路径与可迁移元数据明确分离。

8. **标识、时间、状态与数据版本规范（已确定，2026-07-11）**

   **唯一 ID**

   - `Script`、`Task`、`EnvironmentVariable` 和 `RunRecord` 统一使用 Node `crypto.randomUUID()` 生成 RFC 4122 UUID v4，小写带连字符格式；ID 创建后永不变化。
   - ID 仅作为实体关系和合并导入键，不编码实体类型、创建时间、设备或用户信息；显示名称允许重复。
   - 托管文件名使用 `<script-id>.<controlled-extension>`，日志文件名使用 `<run-id>.log`；扩展名由语言枚举映射，不接受用户提供的路径片段。
   - `Settings` 是单例，不生成 ID；导出包文件以受控相对路径和 SHA-256 标识内容，不把哈希当实体 ID。

   **时间字段**

   - 所有持久化时间统一为 `new Date().toISOString()` 生成的 ISO 8601 UTC 字符串（例如 `2026-07-11T12:34:56.789Z`），界面显示时才转换为本地时区。
   - `createdAt` 创建后不变；任何用户可见配置或脚本内容变化都更新 `updatedAt`；纯读取和运行不更新任务或脚本的 `updatedAt`。
   - `RunRecord.startedAt` 在成功创建子进程前写入；`finishedAt` 在获得终态时写入；`durationMs = finishedAt - startedAt`，不依赖格式化时间。
   - 运行中记录的 `finishedAt`、`durationMs` 为 `null`。应用启动恢复遗留运行记录时，以恢复时刻补 `finishedAt` 和 `durationMs`，状态改为 `interrupted`。
   - Cron 的“下次运行时间”是调度器派生值，不持久化；避免系统休眠、时钟或时区变化后使用过期值。

   **任务配置状态**

   - `Task.enabled: boolean` 仅表示是否参与 Cron 调度，不等价于配置有效或正在运行。
   - 任务可操作性通过运行时校验结果表达：`ready \| script_missing \| interpreter_unavailable \| invalid_cron \| invalid_working_directory`。该值不持久化，每次加载或配置变化后重新计算。
   - 调度器状态为运行时枚举：`active \| inactive \| unavailable`；`unavailable` 表示当前生命周期不支持调度或宿主即将退出。

   **运行状态 `RunStatus`**

   | 状态 | 是否终态 | 含义与允许来源 |
   | --- | --- | --- |
   | `starting` | 否 | 已创建运行记录，正在启动解释器 |
   | `running` | 否 | 子进程已成功启动并获得 PID |
   | `success` | 是 | 正常退出且 `exitCode === 0` |
   | `failed` | 是 | 启动失败，或正常退出但 `exitCode !== 0` |
   | `timed_out` | 是 | 达到超时并由 Scripty 发起终止 |
   | `stopped` | 是 | 用户主动停止并完成进程树清理 |
   | `interrupted` | 是 | preload/ZTools 异常退出后恢复出的遗留运行记录 |

   - 合法主状态流：`starting → running → success|failed|timed_out|stopped`；启动错误允许 `starting → failed`；启动恢复允许 `starting|running → interrupted`。
   - 首个终态胜出并持久化；之后到达的 `exit/error/timeout/stop` 事件不得覆盖已有终态，防止停止与自然退出竞态误分类。
   - `exitCode` 只记录进程实际提供的数值；`timed_out`、`stopped`、`interrupted` 不伪造退出码。终止信号或 Windows 终止原因后续作为诊断字段扩展，不混入状态字符串。

   **触发来源与并发枚举**

   - `RunTrigger = manual | cron | retry`；快速重跑必须记录为 `retry`，同时仍关联原任务。
   - `ConcurrencyPolicy = forbid | limited`；`forbid` 的有效上限固定为 1，`limited` 要求整数 `limit >= 1`。
   - `ScriptLanguage = javascript | python | powershell | shell`，解释器类别使用同一枚举，避免自由文本分支。

   **数据版本**

   - 每个元数据 JSON 根对象统一为 `{ schemaVersion: number, data: ... }`；MVP 初始 `schemaVersion = 1`。
   - 版本号是单调递增整数，只在持久化结构发生不兼容变化时增加；应用版本不用于判断数据兼容性。
   - 读取规则：版本等于当前版本直接校验；低于当前版本按逐版本迁移链处理；高于当前版本立即返回明确的 `UNSUPPORTED_DATA_VERSION`，禁止写回或降级覆盖。
   - 导出协议使用独立的字符串 `formatVersion`（初始 `1.0`），不与本地 `schemaVersion` 共用；前者决定跨设备包兼容，后者决定本机 JSON 迁移。
   - 结论：ID、时间、状态和版本均有单一生成源与比较规则，可避免名称冲突、本地时区歧义、终态竞态和新版本数据被旧程序静默覆盖。

9. **版本化导出包与导入兼容策略（已定义，初始协议 `1.0` / 2026-07-11）**

   **规范目录结构**

   ```text
   scripty-backup.zip
   ├── manifest.json
   ├── data/
   │   ├── scripts.json
   │   ├── tasks.json
   │   ├── environments.json
   │   └── settings.json
   └── scripts/
       └── <script-id>.<controlled-extension>
   ```

   - ZIP 根目录不得再包一层动态文件夹；路径分隔符统一为 `/`，文件顺序不参与协议语义。
   - 不包含 `run-records.json`、运行日志、运行中状态、设备绝对路径、解释器可执行路径或默认工作目录。
   - `data/*.json` 根对象统一包含自身 `schemaVersion` 和 `data`；导出时将设备字段置为 `null` 或从共享设置投影中删除，不复制本地原文件。

   **`manifest.json` 必填结构**

   | 字段 | 规则 |
   | --- | --- |
   | `formatVersion` | 初始值 `1.0`，`major.minor` 十进制字符串 |
   | `appVersion` | 生成端应用 SemVer，仅用于诊断，不决定兼容性 |
   | `exportedAt` | ISO 8601 UTC 时间 |
   | `entities` | `scripts`、`tasks`、`environments` 的非负整数数量 |
   | `options` | `includeEnvironmentValues`、`includeSensitiveValues` 布尔值 |
   | `files` | 除 `manifest.json` 外每个包内文件的 `{ path, sha256, size }`；按路径升序 |

   - SHA-256 对 ZIP 中解压后的原始文件字节计算，小写十六进制；`size` 是原始字节长度。
   - `files` 必须与实际文件集合完全一致：缺失、额外、重复、哈希不符或大小不符均拒绝导入。
   - `entities` 必须与 JSON 实体数量一致；脚本元数据与 `scripts/` 文件必须一一对应，文件扩展名与语言映射一致，内容哈希与 `Script.contentHash` 一致。

   **路径与资源安全校验**

   - 只接受 UTF-8 文件名和清单列出的固定目录；拒绝绝对路径、盘符、UNC、空路径、`.`、`..`、反斜杠、NUL、符号链接和解压后逃逸临时目录的路径。
   - 比较路径时先转换为 `/` 并按 Windows 大小写不敏感规则检测重复，防止 `A.js`/`a.js` 覆盖。
   - 先读取中央目录并应用限制，再解压：MVP 默认最多 10,000 个文件、单文件 10 MiB、JSON 单文件 5 MiB、总解压 100 MiB、压缩比 100:1；超限返回明确错误，不做部分导入。
   - 解压到 `userData/scripty` 之外的系统临时目录，完整校验成功后才进入导入事务；成功或失败均清理临时目录。

   **环境变量与敏感值**

   - 默认 `includeEnvironmentValues=false`：导出变量定义、作用域、备注、启用和敏感标记，但 `value` 写为空字符串并标记 `valueIncluded=false`。
   - 用户显式选择包含普通值时设 `includeEnvironmentValues=true`；敏感值仍默认排除。
   - 只有二次确认后才允许 `includeSensitiveValues=true`；此时清单必须明确记录，导出完成界面提示“包内包含本地明文敏感信息”。
   - 清单选项必须与每个环境变量的 `valueIncluded` 一致；不一致视为损坏或恶意包。

   **格式兼容规则**

   - 解析导入包自身 `formatVersion`，不使用 `appVersion` 推断兼容性。
   - `major` 大于当前支持版本：拒绝并返回 `UNSUPPORTED_EXPORT_VERSION`；`major` 小于当前版本：仅在存在明确逐主版本转换器时接受，否则拒绝。
   - 相同 `major` 下，导入器接受不高于自身支持 `minor` 的包；更高 `minor` 仅当清单和 JSON 不含未知必填能力且声明可忽略扩展时接受，否则拒绝。MVP `1.0` 不声明可忽略扩展，因此高于 `1.0` 一律拒绝。
   - 包内各 `schemaVersion` 必须是导入器可迁移版本；高于当前本地 schema 时拒绝，不尝试降级。

   **预览与导入模式**

   - 校验完成后生成只读预览：新增、更新、保留、冲突、将删除的实体数量；在用户确认前不修改正式数据。
   - **合并导入**：按稳定 ID 匹配。ID 相同则以导入内容更新实体；ID 不同即使名称相同也新增并在预览中提示重名；引用不存在或类型不符则整个导入拒绝。现有但包中不存在的实体保留。
   - **覆盖恢复**：最终实体集合以包内容为准；执行前自动在 `backups/` 创建当前数据完整备份并二次确认。设备字段不从包覆盖，而是保留当前设备设置或重置为 `null`。
   - 两种模式都先在事务临时目录中构造完整目标快照、校验引用和脚本哈希，再通过目录级交换/逐文件原子替换提交；任一步失败不得改变正式数据。

   **冲突与回滚**

   - 同一包内重复 ID、脚本文件冲突、悬空 `scriptId/taskId`、作用域内环境变量重名或非法枚举均属于硬错误，不由“最后一个获胜”。
   - 提交前写入事务描述和目标文件清单；提交失败时恢复提交前快照。覆盖模式的自动备份在成功后仍保留，供用户主动恢复。
   - 导入过程不执行脚本、不探测或启动解释器、不自动启用调度；导入完成后统一进行设备配置检查，任务在解释器和路径重新配置前展示不可运行状态。
   - 结论：协议 `1.0` 可确定性校验并重新导入，合并按稳定 ID、覆盖先备份，且任何格式、路径、哈希、引用或事务错误都不会产生半导入状态。

10. **受限 preload API 设计（已确定，2026-07-11）**

   **统一调用契约**

   - 页面仅访问 `window.scripty`；所有方法返回 `Promise<Result<T>>`，事件订阅返回取消函数 `() => void`。
   - 页面只能提交经过类型定义的 DTO；preload 在边界校验字符串长度、枚举、数字范围、ID 格式、实体引用和用户选择的文件。
   - API 不暴露 `exec`、`spawn`、shell 字符串、解释器外的任意可执行文件调用、通用 `readFile/writeFile`、任意绝对目标路径、Node `fs/path/process` 或内部仓库对象。

   ```ts
   interface ScriptyApi {
     app: AppApi
     scripts: ScriptsApi
     tasks: TasksApi
     runs: RunsApi
     environments: EnvironmentsApi
     history: HistoryApi
     settings: SettingsApi
     backups: BackupsApi
   }
   ```

   **`app` 与只读能力**

   ```ts
   interface AppApi {
     initialize(): Promise<Result<AppSnapshot>>
     getSchedulerStatus(): Promise<Result<SchedulerStatus>>
     openDataDirectory(): Promise<Result<void>>
   }
   ```

   - `initialize` 返回页面首屏所需的类型化快照和已脱敏错误，不返回数据根绝对路径之外的系统信息。
   - `openDataDirectory` 只能打开 preload 已确定的 Scripty 根目录，页面不能传路径。

   **脚本 API**

   ```ts
   interface ScriptsApi {
     list(query?: ScriptQuery): Promise<Result<ScriptSummary[]>>
     get(id: string): Promise<Result<ScriptDetail>>
     create(input: CreateScriptInput): Promise<Result<ScriptDetail>>
     update(id: string, input: UpdateScriptInput): Promise<Result<ScriptDetail>>
     chooseImportFile(): Promise<Result<SelectedScriptFile | null>>
     importSelected(selectionToken: string, input: ImportScriptInput): Promise<Result<ScriptDetail>>
     remove(id: string): Promise<Result<void>>
   }
   ```

   - 文件选择由 preload 调用系统选择器；页面只得到短期 `selectionToken`、显示名和检测语言，不获得可复用的任意文件读取能力。
   - `importSelected` 只允许消费当前会话中由 `chooseImportFile` 生成、尚未使用且未过期的 token，并复制到托管目录。
   - `create/update` 只写对应脚本 ID 的受控托管文件名；`remove` 在 preload 内检查任务引用。

   **任务 API**

   ```ts
   interface TasksApi {
     list(query?: TaskQuery): Promise<Result<TaskSummary[]>>
     get(id: string): Promise<Result<TaskDetail>>
     create(input: CreateTaskInput): Promise<Result<TaskDetail>>
     update(id: string, input: UpdateTaskInput): Promise<Result<TaskDetail>>
     duplicate(id: string): Promise<Result<TaskDetail>>
     setEnabled(id: string, enabled: boolean): Promise<Result<TaskSummary>>
     remove(id: string): Promise<Result<void>>
     validate(input: TaskDraft): Promise<Result<TaskValidation>>
     previewSchedule(cron: string): Promise<Result<SchedulePreview>>
   }
   ```

   - `TaskDraft` 中解释器、脚本 ID、参数数组、工作目录、Cron 和超时保持独立字段；preload 固定使用 `spawn(executable, [scriptPath, ...args], { shell: false })`。
   - `validate` 仅检查配置和可用性，不执行脚本；`previewSchedule` 只解析五段 Cron。

   **运行与实时事件 API**

   ```ts
   interface RunsApi {
     start(taskId: string, trigger?: 'manual' | 'retry'): Promise<Result<RunRecord>>
     stop(runId: string): Promise<Result<RunRecord>>
     getActive(): Promise<Result<ActiveRun[]>>
     subscribe(listener: (event: RunEvent) => void): () => void
   }
   ```

   - 页面不能传解释器、脚本路径或命令给 `start`；preload 只按已持久化且通过校验的任务启动。
   - `stop` 只接受由当前运行注册表持有的 `runId`，并在 preload 内执行进程树终止。
   - `RunEvent` 是带 `runId` 和递增 `sequence` 的判别联合：`status | stdout | stderr | finished`；日志块有最大字节数，页面丢失序列时从历史分块 API 补读。

   **环境变量 API**

   ```ts
   interface EnvironmentsApi {
     list(query?: EnvironmentQuery): Promise<Result<EnvironmentSummary[]>>
     get(id: string, reveal?: false): Promise<Result<EnvironmentDetail>>
     reveal(id: string): Promise<Result<RevealedEnvironmentValue>>
     create(input: CreateEnvironmentInput): Promise<Result<EnvironmentSummary>>
     update(id: string, input: UpdateEnvironmentInput): Promise<Result<EnvironmentSummary>>
     setEnabled(id: string, enabled: boolean): Promise<Result<EnvironmentSummary>>
     remove(id: string): Promise<Result<void>>
     chooseDotEnvImport(): Promise<Result<DotEnvPreview | null>>
     importDotEnv(previewToken: string, input: DotEnvImportInput): Promise<Result<ImportSummary>>
     exportDotEnv(input: DotEnvExportInput): Promise<Result<SaveSummary | null>>
   }
   ```

   - 普通列表永不返回敏感明文；`reveal` 是显式单项操作并可被页面要求二次确认。
   - `.env` 导入使用短期预览 token；导出由 preload 打开保存对话框并写入用户选定文件，页面不传任意路径。

   **历史与日志 API**

   ```ts
   interface HistoryApi {
     list(query: RunHistoryQuery): Promise<Result<Page<RunRecord>>>
     get(runId: string): Promise<Result<RunRecord>>
     readLog(runId: string, input: LogChunkRequest): Promise<Result<LogChunk>>
     retry(runId: string): Promise<Result<RunRecord>>
     clear(input: HistoryCleanupInput): Promise<Result<CleanupSummary>>
   }
   ```

   - `readLog` 通过 `runId` 解析受控日志文件，限制 `offset/length`，不接受文件名或路径。
   - `retry` 从历史的 `taskId` 重新读取当前任务配置，不执行历史命令快照。

   **设置与备份 API**

   ```ts
   interface SettingsApi {
     get(): Promise<Result<SettingsView>>
     update(input: UpdateSettingsInput): Promise<Result<SettingsView>>
     chooseInterpreter(language: ScriptLanguage): Promise<Result<InterpreterSelection | null>>
     validateInterpreter(language: ScriptLanguage, selectionToken: string): Promise<Result<InterpreterValidation>>
   }

   interface BackupsApi {
     previewExport(input: ExportOptions): Promise<Result<ExportPreview>>
     export(previewToken: string, confirmation?: SensitiveExportConfirmation): Promise<Result<SaveSummary | null>>
     chooseImportPackage(): Promise<Result<ImportPackagePreview | null>>
     import(previewToken: string, input: ImportConfirmation): Promise<Result<ImportSummary>>
   }
   ```

   - 解释器选择仍通过短期 token；确认后 preload 才把选中的路径保存为对应语言解释器，不能借此启动任意程序。
   - 导出/导入都必须先 preview，后续调用只接受不可伪造且过期失效的 token；敏感导出和覆盖恢复需要独立确认载荷。
   - 保存位置由系统保存对话框返回给 preload；页面只收到取消或写入摘要。

   **实现边界与安全规则**

   - 每个 API 方法在 preload 内依次执行：输入校验 → 加载领域实体 → 权限/引用检查 → 仓库或执行服务操作 → 结构化结果；页面错误不能绕过该顺序。
   - 所有 token 仅保存在 preload 内存，绑定操作类型和已选择文件的规范化路径，单次使用、短时过期，插件退出即失效。
   - 只允许脚本导入扩展名、备份 `.zip` 和 `.env` 对应的选择器过滤；路径仍需在读取前重新校验文件类型、大小和文件状态。
   - 当前 `window.services.readFile/writeTextFile/writeImageFile` 与生命周期/子进程实验 API 仅属 M0 临时探针，M1 必须删除，不得成为正式接口。
   - 结论：页面只能表达“管理某个 Scripty 实体或运行已保存任务”的意图，不能把 preload 退化为通用命令代理或任意文件系统代理。

11. **错误返回格式与状态流转规则（已确定，2026-07-11）**

   **跨 preload 边界的结果格式**

   ```ts
   type Result<T> =
     | { ok: true; data: T; requestId: string }
     | { ok: false; error: ScriptyError; requestId: string }

   interface ScriptyError {
     code: ErrorCode
     message: string
     recoverable: boolean
     fieldErrors?: Record<string, string>
     details?: Record<string, string | number | boolean | null>
   }
   ```

   - `requestId` 每次 API 调用生成 UUID，用于关联 preload 日志；不暴露堆栈、系统环境、完整命令、敏感变量值或不必要的绝对路径。
   - `message` 是可直接展示的中文摘要；页面按 `code` 决定交互，不解析文案。`recoverable` 表示用户是否可在不重启插件的情况下修正并重试。
   - `fieldErrors` 的键使用 DTO 字段路径（如 `args.2`、`interpreter.executable`）；只用于边界校验错误。
   - `details` 只放安全、结构化且对用户解决问题有帮助的信息，例如 `entityId`、`expectedVersion`、`actualVersion`、`exitCode`；敏感信息先遮罩。
   - preload 内部异常必须在边界捕获、记录完整诊断日志并映射为已知错误；未知异常统一映射 `INTERNAL_ERROR`，不得把 Error 对象直接跨上下文返回。

   **稳定错误码**

   | 类别 | 错误码 | 语义 |
   | --- | --- | --- |
   | 输入 | `VALIDATION_ERROR`、`INVALID_ID`、`INVALID_CRON`、`INVALID_ARGUMENT` | 页面输入不合法，通常可恢复 |
   | 实体 | `NOT_FOUND`、`NAME_CONFLICT`、`REFERENCE_CONFLICT`、`STALE_WRITE` | 实体不存在、唯一约束/引用冲突或基于旧版本更新 |
   | 脚本/路径 | `SCRIPT_MISSING`、`FILE_TOO_LARGE`、`FILE_TYPE_NOT_ALLOWED`、`PATH_NOT_ALLOWED` | 托管文件或用户选择文件不符合约束 |
   | 解释器/运行 | `INTERPRETER_UNAVAILABLE`、`SPAWN_FAILED`、`RUN_ALREADY_ACTIVE`、`RUN_LIMIT_REACHED`、`RUN_NOT_ACTIVE`、`STOP_FAILED` | 执行前检查、启动、并发或停止失败 |
   | 存储 | `DATA_CORRUPTED`、`READ_FAILED`、`WRITE_FAILED`、`DISK_FULL`、`PERMISSION_DENIED` | 本地数据或文件系统错误；损坏数据不得自动覆盖 |
   | 版本/迁移 | `UNSUPPORTED_DATA_VERSION`、`MIGRATION_FAILED`、`UNSUPPORTED_EXPORT_VERSION` | 本地或导出协议不兼容 |
   | 导入/导出 | `PACKAGE_INVALID`、`HASH_MISMATCH`、`PACKAGE_LIMIT_EXCEEDED`、`IMPORT_CONFLICT`、`IMPORT_ROLLBACK_FAILED`、`TOKEN_INVALID`、`TOKEN_EXPIRED` | 包校验、事务、冲突或预览令牌错误 |
   | 生命周期 | `SCHEDULER_UNAVAILABLE`、`PLUGIN_SHUTTING_DOWN`、`INTERNAL_ERROR` | 宿主生命周期或未知内部错误 |

   - 用户取消系统文件选择器、保存对话框或确认流程不是错误：成功结果中的数据为 `null` 或 `{ cancelled: true }`。
   - `DATA_CORRUPTED`、`UNSUPPORTED_DATA_VERSION`、`IMPORT_ROLLBACK_FAILED` 默认 `recoverable=false`，页面必须阻止相关写入并提供打开数据/备份目录或查看详情的操作。

   **运行状态机与事件优先级**

   ```text
   start request
       │ validate task/config/concurrency
       ├─ error ───────────────────────────────> no RunRecord
       └─ create RunRecord(starting)
                  ├─ spawn error ──────────────> failed
                  └─ spawn success ────────────> running
                              ├─ exit 0 ────────> success
                              ├─ exit non-zero ─> failed
                              ├─ timeout ───────> timed_out
                              ├─ user stop ─────> stopped
                              └─ startup recovery> interrupted
   ```

   - 配置校验或并发拒绝发生在创建 `RunRecord` 前，返回错误而不制造虚假失败历史；真正的 spawn 尝试失败才创建并终结为 `failed`。
   - 每个运行维护内部 `terminalDecision` 原子门闩。首个决定终态的来源胜出：用户已请求停止则后续 `exit` 归类为 `stopped`；超时先触发则归类为 `timed_out`；否则按退出码归类。
   - 状态持久化顺序：先原子写入终态记录，再广播 `finished` 事件，最后从活动运行注册表移除；页面收到终态后再次 `stop` 返回 `RUN_NOT_ACTIVE`，不得改写历史。
   - `error` 与 `exit` 可能都触发，执行服务必须保证只结束一次；日志流在终态前完成剩余缓冲写入，终态后到达的输出不再广播但可记录诊断警告。
   - `stop` 成功的含义是目标进程树已不存在，不是“已发送终止信号”；清理超时返回 `STOP_FAILED`，运行保持可追踪且错误摘要说明可能存在残留进程。

   **并发状态规则**

   - 启动前以任务 ID 查询活动运行数，并在同一 preload 串行临界区内“检查并登记”，避免连续点击竞态。
   - `forbid` 且已有活动运行时返回 `RUN_ALREADY_ACTIVE`；`limited` 达上限时返回 `RUN_LIMIT_REACHED`，均不创建运行记录。
   - 不同任务默认可并行；全局资源上限属于设置层后续扩展，不在 MVP 模型中隐式限制。

   **调度器状态流转**

   ```text
   initialize ── lifecycle supported ──> active
       │                                  │
       └─ unsupported/error ───────────> unavailable
                                          │
   user pauses / no enabled cron ──────> inactive
   task/settings change ───────────────> rebuild schedules ──> active|inactive
   plugin out(false) / hidden ─────────> state unchanged
   plugin out(true) / ZTools exit ─────> unavailable + stop accepting triggers
   ```

   - `active` 表示调度器存活并已加载启用任务，不保证每个任务配置有效；无启用 Cron 任务时为 `inactive`。
   - 窗口隐藏和 `outPlugin(false)` 不暂停调度器；`outPlugin(true)` 或宿主退出前停止接受新触发，并将 UI 文案固定为“仅在插件存活期间调度”。
   - 修改任务、Cron 或启用状态采用单任务热更新；更新失败保留旧调度并返回错误，不进入部分应用状态。
   - 同一计划时间使用 `(taskId, scheduledAt)` 去重；休眠恢复只计算当前时间之后的下一次执行，MVP 不补跑所有错过时刻。

   **存储与恢复规则**

   - 任何写入遵循“校验完整目标 → 写同目录临时文件 → flush/关闭 → 原子替换”；失败保留原文件并返回结构化存储错误。
   - 读取 JSON 失败时保留损坏文件，返回 `DATA_CORRUPTED`，禁止用默认空数据静默覆盖；初始化仅在文件确实不存在时创建默认数据。
   - 启动时扫描 `starting/running` 记录并统一恢复为 `interrupted`；若对应子进程是否存活无法可靠确认，Windows MVP 仍按宿主异常中断处理并记录诊断。
   - 结论：页面始终收到可序列化、可定位、可决定交互的结果；运行和调度状态只有明确合法路径，竞态不会覆盖首个终态，损坏数据不会被静默重置。

建议数据模型：

- `Script`：名称、托管文件名、语言、内容哈希、备注、创建/更新时间
- `Task`：名称、脚本 ID、解释器、参数、工作目录、Cron、超时、启用状态、环境变量引用
- `EnvironmentVariable`：名称、值、备注、是否启用、是否敏感
- `RunRecord`：任务 ID、触发来源、开始/结束时间、退出码、状态、日志路径
- `Settings`：默认解释器、默认超时、日志保留策略、并发策略、数据版本
- `ExportManifest`：导出格式版本、应用版本、导出时间、实体数量和文件校验信息

验收标准：

- 能通过最小实验说明插件可支持的调度生命周期
- 能启动一个测试脚本、连续接收 stdout/stderr 并主动终止
- 本地数据目录与 preload API 边界形成明确结论
- `ztools-ui` 可在插件中正确渲染亮色和暗色主题
- 一个最小导出包可被校验并重新导入
- 若后台调度不可行，MVP 产品文案和实现范围已调整为前台/存活期调度

### M1：应用壳与本地数据层

目标：将当前示例工程改造成基于 `ztools-ui` 的任务管理插件骨架。

任务：

- [ ] 将 `plugin.json` 的示例入口替换为 Scripty 主入口和快捷指令
- [ ] 移除 Hello、读文件、写文件示例页面及对应示例服务
- [ ] 安装并配置 `ztools-ui`，统一组件注册、主题和样式入口
- [ ] 使用 `ztools-ui` 搭建主布局、导航、空状态、确认对话框和通知反馈
- [ ] 建立脚本、任务、环境变量、运行记录、设置和导出清单的 TypeScript 类型
- [ ] 建立 preload 服务的类型化调用接口
- [ ] 实现本地元数据仓库、数据初始化和原子写入
- [ ] 实现托管脚本文件仓库和日志文件仓库
- [ ] 实现数据结构版本与迁移入口
- [ ] 完成亮色、暗色主题和基础键盘可用性
- [ ] 增加必要的单元测试与构建检查

验收标准：

- 插件可从 ZTools 指令正常进入主界面
- 所有通用控件均来自 `ztools-ui`，没有重复实现同类基础组件
- 页面刷新或插件重新进入后数据保持一致
- 数据文件损坏时不会静默覆盖原数据，并能给出可处理的错误
- `npm run build` 通过

### M2：脚本与任务管理

目标：用户可以创建和维护可执行任务。

任务：

- [ ] 使用 `ztools-ui` 实现任务列表、搜索、状态筛选和启用/禁用
- [ ] 实现创建、编辑、复制和删除任务
- [ ] 支持通过文件选择器导入本地脚本，并复制到插件托管目录
- [ ] 支持在内置编辑器中新建和修改脚本源码
- [ ] 支持 JavaScript、Python、PowerShell 和 Shell 脚本的解释器配置
- [ ] 支持参数、工作目录、超时和任务备注
- [ ] 校验托管脚本、解释器路径和 Cron 表达式
- [ ] 展示脚本丢失、解释器不可用等可操作错误
- [ ] 修改托管脚本不影响用户最初导入的外部源文件

验收标准：

- 用户可在界面中完整维护任务和脚本并在重启后恢复
- 导入脚本后，即使原文件移动或删除，托管副本仍可使用
- 常见脚本类型可以正确识别或手动选择解释器
- 删除、文件缺失和非法配置都有明确反馈
- 不存在通过任务名称或参数注入额外 shell 命令的路径

### M3：安全的脚本执行与实时日志

目标：完成从手动运行到结果追踪的核心闭环。

任务：

- [ ] 使用 `child_process.spawn` 实现结构化进程启动
- [ ] 分离解释器、脚本路径和参数，默认不启用 shell 模式
- [ ] 实现 stdout/stderr 实时流式传输
- [ ] 使用 `ztools-ui` 展示运行中、成功、失败、超时、已停止等状态
- [ ] 实现停止任务及子进程树清理，覆盖 Windows 行为
- [ ] 实现任务级并发策略：禁止重入或允许有限并发
- [ ] 实现默认超时和任务级超时覆盖
- [ ] 写入运行记录与独立日志文件
- [ ] 展示退出码、运行耗时、触发来源和错误摘要
- [ ] 插件异常退出后，将遗留的“运行中”记录恢复为“异常中断”

验收标准：

- 可运行至少 JavaScript、Python 和 PowerShell 示例脚本
- 长任务日志可持续展示且界面不卡顿
- 用户能停止运行中的任务，且不会遗留子进程
- 同一任务不会因连续点击产生非预期并发
- 失败、超时和异常中断可被准确区分

### M4：环境变量管理

目标：任务能够安全、可控地复用运行配置。

任务：

- [ ] 使用 `ztools-ui` 实现环境变量列表及增删改查
- [ ] 支持启用、禁用、备注和敏感标记
- [ ] 支持全局变量与任务级覆盖
- [ ] 运行任务时合并系统环境、全局变量和任务变量
- [ ] 敏感值默认遮罩，查看或复制需要显式操作
- [ ] 在实时日志和历史日志写入前遮罩已知敏感值
- [ ] 提供 `.env` 导入与导出；导出敏感值前二次确认
- [ ] 明确提示敏感变量以本地数据形式保存，不等同于系统密钥库

验收标准：

- 脚本可读取正确合并后的环境变量
- 禁用变量不会注入任务进程
- 敏感值不会在普通列表、错误摘要和日志中明文出现
- 导出操作不会在无提示情况下泄露敏感信息

### M5：Cron 调度

目标：在已验证的 ZTools 生命周期范围内可靠执行定时任务。

任务：

- [ ] 集成 Cron 解析能力并支持常见五段表达式
- [ ] 使用 `ztools-ui` 提供周期预设和下次运行时间预览
- [ ] 实现任务启用、禁用和调度器热更新
- [ ] 记录手动触发与定时触发来源
- [ ] 处理错过执行、系统休眠、时钟变化和重复触发
- [ ] 根据任务并发策略处理上一次尚未结束的情况
- [ ] 在界面展示调度器当前是否有效及其生命周期限制
- [ ] 添加快捷指令：打开任务库、运行指定任务、查看运行中任务

验收标准：

- 启用任务会在预期时间触发，禁用后不再触发
- 修改 Cron 后无需重启插件即可生效
- 系统休眠恢复后不会无界补跑或重复运行
- 用户始终能判断调度器当前是否处于工作状态

### M6：导出、导入与 MVP 发布

目标：支持可靠备份和设备迁移，并达到可长期自用的首个发布版本。

任务：

- [ ] 定义版本化导出包，包含清单、脚本、任务、共享设置和可选环境变量
- [ ] 默认不导出运行日志、运行中状态、设备绝对路径和解释器路径
- [ ] 导出前允许用户选择是否包含环境变量和敏感值
- [ ] 敏感值导出必须二次确认，并在导出结果中明确安全提示
- [ ] 导入前校验格式版本、必填字段、脚本哈希、文件路径和数据大小
- [ ] 导入前展示内容摘要和变更预览
- [ ] 支持“合并导入”和“覆盖恢复”两种模式
- [ ] 合并时按稳定 ID 判断实体，重名但 ID 不同的内容不得静默覆盖
- [ ] 覆盖恢复前自动创建当前数据备份，并进行二次确认
- [ ] 导入失败时保持原数据不变，避免产生半导入状态
- [ ] 实现运行历史筛选、详情查看和失败任务快速重跑
- [ ] 实现日志按任务、数量或保留天数清理
- [ ] 对大日志采用分页或分块读取，限制页面内存占用
- [ ] 覆盖路径包含空格、中文和特殊字符的场景
- [ ] 覆盖解释器缺失、脚本被删除、权限不足和磁盘写入失败
- [ ] 覆盖 ZTools 退出、插件重载和任务执行中关闭界面的行为
- [ ] 在两台干净设备间完成导出和导入迁移测试
- [ ] 完成 Windows 端到端验证与回归检查
- [ ] 更新 README、插件描述、图标、版本号和发布说明
- [ ] 产出 MVP 安装包并进行干净环境验证

验收标准：

- 任务创建、运行、调度、日志和环境变量形成完整闭环
- 导出包可在另一台设备导入，并恢复脚本和任务关系
- 合并、覆盖、版本不兼容和损坏包都有明确且可恢复的处理方式
- 未经确认不会导出敏感变量值
- 导入失败不会破坏已有数据
- 连续运行与日志累积不会导致明显内存增长或界面卡顿
- 已知生命周期限制、数据安全说明和非目标均有用户可见说明
- 生产构建可被 ZTools 正常加载

## 5. 导出包建议结构

```text
scripty-backup.zip
├── manifest.json
├── data/
│   ├── scripts.json
│   ├── tasks.json
│   ├── environments.json
│   └── settings.json
└── scripts/
    └── <script-id>.<ext>
```

约束：

- `manifest.json` 必须包含格式版本、应用版本、导出时间、实体数量和文件哈希。
- 压缩包内路径必须使用受控相对路径，导入时拒绝绝对路径和 `..` 路径穿越。
- 解释器路径、默认工作目录等设备相关设置不进入导出包，导入后由新设备重新配置。
- 运行记录和日志默认不导出；后续可提供独立的诊断日志导出，不与配置备份混合。
- 环境变量定义可以导出，变量值由用户选择；敏感值默认排除。
- 导入过程先解压到临时目录、完整校验，再以事务式步骤写入正式数据目录。

## 6. MVP 后续候选

以下能力按实际使用反馈排序，不预先承诺版本。

### P1：体验增强

- 批量启用、禁用、运行和删除任务
- 任务标签、收藏、排序和快捷键
- Cron 可视化编辑器
- 桌面通知和失败提醒
- 任务耗时与成功率统计

### P2：脚本来源与依赖

- Git 仓库拉取和指定目录导入
- 远程脚本下载、更新预览与变更确认
- Node/Python 项目依赖安装
- 脚本模板和本地模板库

远程内容必须先下载、展示来源和变更，并由用户确认后才可执行；不得默认静默更新并运行。

### P3：后台能力

- 独立本地守护进程
- 开机启动
- 插件关闭后的持续调度
- 守护进程状态与版本管理

仅当 M0 证明 ZTools 生命周期不能满足目标、且用户确实需要后台调度时再引入。守护进程会显著增加安装、升级、权限和跨平台成本。

### P4：高级能力

- 任务依赖和串并行工作流
- Webhook 或本地 API 触发
- 系统密钥库集成
- 可选的用户主动同步方案

## 7. 关键风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| ZTools 插件退出后调度停止 | 无法达到青龙式后台定时体验 | M0 优先实测；MVP 明示生命周期，必要时后续独立守护进程 |
| 通用 shell 执行造成命令注入 | 任务参数可能执行非预期命令 | 使用 `spawn` 参数数组，默认 `shell: false`，限制 preload API |
| 停止任务后遗留子进程 | 持续占用资源或产生副作用 | 针对 Windows 实现并测试进程树终止 |
| 环境变量或导出包泄露密钥 | 暴露账号和令牌 | 敏感标记、默认排除、日志脱敏、导出二次确认 |
| 恶意导入包路径穿越 | 覆盖插件目录外的文件 | 拒绝绝对路径与 `..`，限制解压目录并校验清单 |
| 导入中断或覆盖失败 | 破坏现有任务数据 | 预校验、自动备份、临时目录和事务式替换 |
| 大量日志阻塞 UI | 卡顿或内存溢出 | 流式传输、批量刷新、分块读取和保留策略 |
| 本地 JSON 数据异常损坏 | 丢失任务配置 | 原子写入、备份、版本迁移和显式恢复流程 |
| 自动下载远程脚本 | 引入供应链和静默执行风险 | 不进入 MVP；后续必须预览变更并显式确认 |
| 多解释器跨平台差异 | 迁移后任务无法直接运行 | 不导出设备路径；导入后进行解释器检查和重新配置 |
| `ztools-ui` 能力缺口 | 页面出现不一致的自研组件 | M0 提前盘点；优先组合现有组件，仅对业务组件做封装 |

## 8. 建议实施顺序

严格按 `M0 → M1 → M2 → M3 → M4 → M5 → M6` 推进。

其中 M3 是产品价值的首个完整验证点：如果脚本执行、日志流和停止机制不可靠，应暂停环境变量和 Cron 开发，先修正执行模型。Cron 不应先于执行稳定性实现，否则会放大重复运行、残留进程和日志失控问题。

导出和导入的数据结构应在 M0 确定，并随数据模型持续维护；完整 UI 和迁移验证集中在 M6 完成，避免到发布阶段才发现已有数据无法稳定迁移。

## 9. MVP 完成定义

满足以下条件时，可将版本标记为首个可发布 MVP：

- 用户可以创建或导入本地脚本任务
- 用户可以安全地手动运行、停止任务并查看实时输出
- 用户可以配置环境变量，敏感值默认不明文展示
- 用户可以设置 Cron，并清楚了解调度生命周期
- 用户可以查看历史运行、失败原因和日志
- 用户可以导出完整配置，并在另一台设备安全导入
- 导入支持预览、合并、覆盖备份和失败回滚
- 所有通用界面组件统一使用 `ztools-ui`
- Windows 下核心流程完成端到端验证
- 构建产物可在 ZTools 中正常安装和运行

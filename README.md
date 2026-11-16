# WinMon — 轻量级监控系统

类似 Zabbix 的轻量监控系统，面向 Windows 部署（**Windows 7 SP1 / 8.1 / 10 / 11 及 Linux**），**内置 Node.js 运行时，下载解压后双击即可运行**，无需安装任何环境。支持 Agent 深度采集与无代理探测两种方式，纯 Node.js 实现（无第三方依赖），数据存于自带的文件型存储引擎，深色中文 Web 界面，完全离线可用。

## 快速开始

1. 到 [Releases](../../releases) 下载 `winmon-server-windows-v1.8.0.zip`（文件名带版本号，请以 Releases 页最新版本为准）。
2. 解压到**可写目录**（推荐 `D:\WinMon`，不要放在 `Program Files` 或 C 盘根目录），双击 `start.bat`。
3. 启动器会先做一遍环境自检，通过后后台启动服务并确认接口已响应，浏览器自动打开 `http://127.0.0.1:8686`。

`start.bat` 的四步流程：检查运行时 → 环境自检 → 后台启动（无残留 cmd 窗口）→ 轮询健康接口确认真的起来了。
**任何一步失败都会留在窗口里并给出原因**，同时生成中文诊断报告；后台启动超时会自动转为前台运行，把报错直接打在屏幕上。

停止服务：双击 `stop.bat`，或点 Web 界面右上角「停止服务」。重启服务：点右上角「重启服务」（短暂中断后自动恢复，页面自动刷新）。后台运行日志见 `data/server.log`。
如需前台控制台调试，用 `start-console.bat`。

### 在线升级

v1.8.0 起可直接在网页里升级：把新版服务端包（`winmon-server-windows-v*.zip`）**拖到页面任意位置**，或点右上角「升级」选择文件。页面会显示上传进度，校验通过后显示「当前 vX → 新版本 vY」，点「立即升级」即自动替换程序文件并重启，服务恢复后页面自动刷新。

- 升级保留设备、历史数据与 `config.json`（自定义端口等设置不变），只替换程序文件。
- 只接受**高于当前版本**的完整服务端包；同版本或更低会被拒绝，解包校验失败也不会改动任何程序文件。
- 只允许本机（127.0.0.1）操作；程序目录不可写时会提示先把整个目录移到可写位置。
- 接管与替换日志在 `data\upgrade-helper.log`；`data\upgrade` 是临时目录，下次启动自动清理。
- **从 v1.7.0 及更早版本升到 v1.8.0 需要手动一次**：下载新包解压覆盖原目录（保留 `config.json` 与 `data`），之后即可在线升级。
- 升级中途断电等意外：先看 `data\upgrade-helper.log`，仍起不来就双击 `start.bat`；数据目录不受升级影响。

## 启动不了怎么办

双击 **`diagnose.bat`**，它会逐项检查并生成中文报告 `data/diagnose.txt`（UTF-8 带 BOM，Win7 记事本可正常显示）并自动打开：

| 检查项 | 说明 |
|--------|------|
| 运行时 | Node 版本与位数、`node.exe` / `node-x86.exe` 是否存在且完整、与系统位数是否匹配 |
| 系统 | Windows 版本与是否安装 SP1（Win7 必须 SP1） |
| 程序完整性 | 22 个必需文件是否齐全 |
| 目录权限 | 程序目录与数据目录是否可写，只读时实际落盘位置 |
| 模块与存储 | 全部 lib 模块能否加载、二进制时序读写往返、**全新数据库初始化能否跑通** |
| 外部工具 | PowerShell 版本、`collect.ps1` 实际执行结果、Ping 回环、磁盘可用空间 |
| 端口 | 端口是否被占用、是否已有 WinMon 在运行 |
| 下载锁定 | `.bat` / `node.exe` 是否带有下载标记（需右键 zip → 属性 → 解除锁定） |

常见原因与处理：

1. **解压到了 `Program Files` 或 C 盘根目录** —— 普通权限无法写入。v1.5.1 起会自动把数据与配置改存到 `%LOCALAPPDATA%\WinMon\data` 并在日志与报告中写明；更干净的做法是把整个目录移到 `D:\WinMon`。
2. **Windows 7 未安装 SP1** —— 内置 Node 12 只支持 SP1 及以上。
3. **32 位系统缺少 `runtime\node-x86.exe`** —— 请完整解压发布包，`pick-node.bat` 会自动选对位数。
4. **zip 带下载锁定标记或杀毒软件拦截 `node.exe`** —— 解除锁定后重新解压，并把目录加入白名单。
5. **端口被占用** —— 改 `config.json` 的 `server.port`。
6. **服务在跑但界面打不开** —— Win7 自带的 IE11 无法运行本界面，见下文。

## Windows 7 支持

Win7 SP1（32 位与 64 位）可直接运行，无需额外安装补丁或运行库：

| 项目 | 说明 |
|------|------|
| 运行时 | 内置 **Node.js 12.22.12**（最后一个支持 Win7 的 LTS）。`runtime/node.exe` 为 64 位，`runtime/node-x86.exe` 为 32 位，`pick-node.bat` 按系统位数自动选择 |
| 启动脚本 | 全部 `.bat` 为纯 ASCII 且**不使用 `chcp 65001`** —— Win7 的 cmd.exe 切换代码页后会丢失批处理读取位置，导致脚本静默中断。中文只写入带 BOM 的报告文件 |
| 后台启动 | `start-hidden.vbs` 不再创建目录、也不再用 `>>` 重定向（目录只读时会抛出被 `//B` 吞掉的错误，表现为「双击后什么都没发生」）。日志由 `server.js` 自己写入 |
| 依赖库 | 不依赖 VC++ 运行库、.NET 4.x 或 PowerShell 3.0；HTTPS 使用 Node 自带的 OpenSSL 与 CA 证书，不受 Win7 系统 TLS 设置影响 |
| 指标采集 | `lib/collect.ps1` 优先用 CIM，检测到 PowerShell 2.0 时自动回退 `Get-WmiObject`，并手工拼装 JSON（PS 2.0 无 `ConvertTo-Json`） |
| Ping 解析 | 中文版 Windows 的 `ping.exe` 输出是 GBK，按 UTF-8 解码会让「时间=xx ms」变乱码。现取原始字节还原，只在含 `TTL=` 的应答行用纯 ASCII 模式取时延，中英文与 Linux 通用 |
| 数据存储 | 纯 JS 存储引擎，不使用 `node:sqlite`（需 Node 22+）。**旧版 `data/monitor.db` 首次启动自动迁移**，见下文 |
| 打包脚本 | `make-package.js` 用 Node 自带的 zlib 生成 zip，替代 Win7 上不存在的 `Compress-Archive` |
| 浏览器 | Win7 最高可用 **Chrome 109.0.5414.120** 或 **Firefox 115 ESR**。**IE11 无法运行本界面** |

**关于 IE11**：Win7 自带的 IE11 缺少现代 JS/CSS 能力，无法渲染仪表盘。此时页面不会白屏，而会显示一张兼容指引页，列出缺失的能力、当前服务状态与局域网访问地址 —— 监控服务本身运行正常，可改用局域网内其它电脑/手机的浏览器访问，或在本机安装上表中的浏览器。

## 界面与运维
- **主题切换**：右上角「浅色/深色」按钮切换深浅主题，选择保存在浏览器本地，图表随主题重绘。
- **Web 停止/重启服务**：右上角「停止服务」「重启服务」按钮（均含确认弹窗），仅允许本机回环地址调用。重启会拉起新进程并自动接管端口，页面在恢复后自动刷新。
- **通知设置**：右上角「通知设置」按钮配置告警通知，支持 SMTP 邮件（SSL/STARTTLS/明文 + AUTH LOGIN）与 Webhook，可一键发送测试邮件。
- **主机管理（设备列表）**：原「探测配置」与「主机管理」合并为单一「主机管理」页，分两个分区：**探测设备**（手工添加）与 **Agent 上报主机**（Agent 自动注册）。两者都**按类型分组**显示（摄像机/交换机/防火墙/控制器/Linux/Windows/数据库/网络链路/应用/其他），组内**默认按 IP 数值排序**，顶部搜索框按名称或 IP 同时过滤两个分区，无需再手动选择类型。**点分组标题可折叠/展开该组**，折叠状态记在浏览器本地，刷新后保持。
- **设备自定义名称**：Agent 主机在「Agent 上报主机」分区点「改名/类型」即可改名与归类；改过的名字**优先级最高**，Agent 后续上报不会覆盖。未手工改过时跟随 Agent 配置的 `agent.name`，留空则用计算机名（名字后带 `(自动)` 标记）。Agent 主机的类型按操作系统自动推断，可手工改。探测设备改名会同步写入探测配置。
- **内置示例模板**：首次启动自动为 10 种设备类型各建一个「示例-xxx」探测设备，**默认停用**（不探测、不告警、不生成概览卡片），导出 JSON/CSV 时可照着填参数。改成真实地址后启用，或直接删除 —— 只播种一次，删掉后重启不会再出现。
- **忽略单台设备告警**：主机管理里每台设备（探测设备与 Agent 主机都可）有「忽略告警」按钮，主机详情页也有。忽略后**自动关闭该设备现有活动告警**，之后不再产生新告警、不发邮件/Webhook，且**不在概览显示**；采集与在线判断照常，主机管理里仍可见并带「已忽略告警」标记。点「恢复告警」即恢复。
- **多选批量操作**：探测设备表格首列勾选框支持多选与全选，选中后出现批量操作栏，可批量修改（启用/停用、探测间隔、设备类型）与批量删除。
- **设备导入导出**：主机管理页支持 JSON / CSV 导入导出（见下文）。
- **主机详情管理**：在「概览」点击设备卡片进入详情，可「改名/类型」、编辑探测配置（探测设备），并删除主机。

> 运行时（`runtime/node.exe` 等）体积超过 GitHub 单文件限制，未纳入源码仓库，而是作为 Release 资产分发。克隆源码后需自行准备 `runtime/node.exe`（Node.js 12.22.12，Win7 兼容）与 `runtime/node-x86.exe`（32 位系统）才能运行。

## 监控能力

### 1. Agent 采集（服务器 / 电脑深度指标）
CPU、内存、磁盘、网络速率、进程数、运行时长。

- **Windows**（7 SP1 / 8.1 / 10 / 11，32 位或 64 位）：下载 `agent-windows-v1.8.0.zip`，解压后修改 `config.json` 中 `agent.server_url` 指向服务端（可一并设 `agent.name` 作为显示名称），然后：

  | 脚本 | 行为 |
  |------|------|
  | `agent-background.bat` | **后台运行，无窗口**。启动后确认上报成功才提示可关窗口，**关掉启动窗口 Agent 继续跑**。失败时自动转前台显示报错 |
  | `agent.bat` | 前台运行，日志打在窗口里，**关窗口即停止** |
  | `agent-stop.bat` | 停止后台 Agent |
  | `agent.js --status` | 查看状态（`OK`/`FAIL`/`STALE`/`STOPPED`/`STARTING`） |

  日志写 `data/agent.log`（UTF-8 带 BOM）。重复启动会被拦下并提示已运行的 PID，不会跑出两个 Agent。
  开机自启：把 `agent-background.bat` 的快捷方式放进 `shell:startup`。
- **Linux**：下载 `agent-linux-v1.8.0.zip`（内置 Linux Node，基于 `/proc` 采集），解压后：
  ```sh
  chmod +x runtime/node agent.sh
  ./agent.sh                      # 前台
  nohup ./agent.sh >/dev/null 2>&1 &   # 后台，日志见 data/agent.log
  ./runtime/node agent.js --stop  # 停止
  ```

### 2. 无代理探测（摄像机 / 交换机 / 防火墙 / 控制器 / 骨干网 / MV网 / 数据库 / 应用）
在「主机管理」页添加设备，按需勾选检查项：

| 检查 | 说明 |
|------|------|
| Ping | 可达性、时延、丢包率（任何 IP 设备，含链路） |
| TCP 端口 | 判断应用是否存活、端口响应时间 |
| HTTP | Web 服务状态码与响应时间 |
| SNMP v1/v2c | 接口入/出带宽、接口状态、设备运行时长、CPU |
| 数据库真实登录 | MySQL/MariaDB、SQL Server、Redis，用真实账号完成握手认证，判断数据库能否正常连接 |

## 告警与界面
概览仪表盘、主机管理、告警中心、触发器。**概览里有活动告警的设备自动置顶**（卡片描红边）；已忽略告警的设备不在概览出现，统计栏单列「已忽略告警(不显示)」台数，主机总数与在线数也只统计显示出来的设备。内置默认触发器（丢包过高、时延过高、端口不通、数据库连接失败、HTTP 异常、SNMP 不可达等），支持自定义阈值 / 持续次数 / 严重级，告警自动产生与恢复。告警触发与恢复时可推送 **SMTP 邮件**与 **Webhook** 通知（右上角「通知设置」）。删除设备会同步清除其概览卡片、历史数据与告警，不再残留。数据默认保留 7 天。

## 配置

**完整配置文档见 [CONFIG.md](CONFIG.md)** —— 逐字段说明服务端与 Agent 的所有配置项、默认值、取值范围、生效方式与常见场景排查。发布包内含同名文件，界面「主机管理 → 配置说明」也可直接打开。

服务端与 Agent 共用一份 `config.json` 结构，但**各读各的段**：服务端只读 `server` / `collection` / `retention_days` / `token` / `webhook_url` / `mail`，Agent 只读 `agent`。**在服务端配置里改 `agent` 段不会有任何效果。**

常用项：
- `server.port`：Web 端口（默认 8686）；`server.host`：监听地址（默认 `0.0.0.0`）；`server.local_name`：服务端本机显示名
- `collection.interval_sec`：本机采集间隔，同时决定离线阈值 `max(90, interval_sec×4)` 秒
- `retention_days`：历史数据保留天数（已恢复告警固定保留 30 天）
- `token`：Agent 上报校验令牌（可选，**仅保护上报接口，不保护 Web 界面**）
- `agent.server_url` / `agent.token` / `agent.interval_sec`（最小 5 秒）/ `agent.hostname`（主机标识，改了等于换新主机）/ `agent.name`（显示名称）
- `webhook_url`：告警 Webhook（可选）
- `mail`：SMTP 邮件通知，含 `enabled`、`host`、`port`、`secure`（`ssl`/`starttls`/`none`）、`user`、`pass`、`from`、`to`（多个收件人用逗号分隔）。推荐直接在 Web「通知设置」中填写并发送测试邮件，密码仅保存于服务端 `config.json`，接口不回传明文。

改完服务端配置需**重启服务**；改完 Agent 配置需**重启 Agent**。邮件与 Webhook 在界面保存后立即生效。

## 设备存储与导入导出
- 所有设备与历史数据保存在 **`data/`** 下（自带文件型存储引擎，无第三方依赖）。程序目录可写时为 `<程序目录>\data`；
  程序目录只读（解压到 `Program Files` 或 C 盘根目录）时自动改用 **`%LOCALAPPDATA%\WinMon\data`**，`config.json` 同样改存到该目录。
  实际路径会在启动日志与诊断报告中写明，也可用环境变量 `WINMON_DATA_DIR` 指定：
  - `data/store.json`：设备与配置（Agent 主机 `hosts`、探测设备 `targets` / `checks`、触发器 `triggers`、告警 `alerts`、一次性初始化标记 `flags`），原子写入（临时文件 + 重命名）。
  - `data/history/h<主机ID>/<指标>.bin`：历史指标，按主机与指标分文件的定长二进制序列（每条 16 字节：时间戳 + 数值），范围查询用二分查找，绘图自动降采样。文件名用十六进制编码，避免 `disk.used_pct[C:]` 这类指标名中的 `:` 在 Windows 上非法。
  - `data/server.log`：服务端运行日志，由服务端自己追加写入（UTF-8 带 BOM，Win7 记事本可直接阅读），带时间戳。
  - `data/agent.log`：Agent 运行日志，格式同上；`data/agent-state.json` 记录最近一次上报结果，供 `agent.js --status` 判断。
  - 备份/迁移直接复制整个 `data/` 目录即可（建议先停止服务）。
- **从旧版 SQLite 自动迁移**：v1.4.0 及更早版本使用 `data/monitor.db`。升级后首次启动会自动读取该文件（含未落盘的 `-wal` 日志），把设备、触发器、告警与全部历史数据导入新引擎，随后把旧文件重命名为 `monitor.db.migrated` 保留备份，迁移只执行一次。迁移结果写入 `data/server.log`。
- **批量导入/导出**：在「主机管理」页工具栏提供 `导入` / `导出` 按钮：
  - 导出：JSON（完整备份，含探测参数）或 CSV（可用 Excel 编辑）。
  - 导入：支持上述 JSON 或 CSV；导入为**新增**，不覆盖现有设备。CSV 表头可点「下载 CSV 模板」获取。
  - 编码自动识别：导入 CSV 自动兼容 UTF-8（含 BOM）、GBK/ANSI（Excel 中文 Windows 默认另存格式）、UTF-16，中文名称不再乱码。
  - CSV 列：`name,type,address,interval_sec,enabled,ping,tcp_port,http_url,snmp_community,snmp_version,snmp_ifindex,snmp_cpu_oid,db_type,db_port,db_user,db_password,db_name,note`。
- **按类型分组**：「主机管理」页将设备按 摄像机/交换机/防火墙/控制器/Linux/Windows/数据库/网络链路/应用/其他 分组显示，每组带彩色标记与数量，组内按 IP 数值升序排列；**点分组标题可折叠/展开**，状态保存在浏览器本地，搜索时临时展开所有匹配组而不改动已保存的偏好；顶部搜索框支持按名称或 IP 即时过滤。

## 目录结构
```
server.js        服务端（Web + API + 探测调度）
agent.js         Agent 上报端（--status 查状态 / --stop 停止）
upgrade-helper.js 在线升级接管进程（旧进程退出后替换文件并拉起新版）
preflight.js     启动自检 / 诊断（--quick / --full / --wait=N / --url）
CONFIG.md        服务端与 Agent 完整配置文档
lib/             采集 / 存储 / 告警 / 邮件通知 / SNMP / 数据库检测 / 探测引擎 / HTTP 客户端 / 路径解析 / 日志 / 打包 / 解包 / 在线升级
public/          Web 前端（原生 JS + Canvas，无外部依赖；compat.js 为 ES5 浏览器兼容闸门）
runtime/         内置 Node.js 运行时（Release 资产：node.exe / node-x86.exe / node-linux）
pick-node.bat    按系统位数选择运行时
diagnose.bat     生成中文诊断报告 data/diagnose.txt 并用记事本打开
agent-background.bat / agent-hidden.vbs   Agent 后台启动（无窗口，关窗口不停止）
agent-stop.bat   停止后台 Agent
*.bat / *.vbs    Windows 启动 / 停止 / 打包脚本（纯 ASCII，不使用 chcp）
make-package.js  纯 Node 打包器（server / agent / linux）
agent.sh         Linux Agent 启动脚本
```

## 从源码打包
- Windows Agent：`make-agent.bat` → `agent-windows-v<版本>.zip`（同时生成固定名 `agent-package.zip` 供页面下载）
- Linux Agent：`make-agent-linux.bat` → `agent-linux-v<版本>.zip`
- 完整服务端：`make-server.bat` → `winmon-server-windows-v<版本>.zip`（包内附 `VERSION` 文件，版本号取自 `server.js`）
- 也可直接 `node make-package.js all` 一次生成全部资产。

## 技术栈
Node.js 12.22.12（Win7 兼容，自带 OpenSSL）、原生 HTTP/UDP/TCP、自实现文件型存储引擎（JSON 元数据 + 定长二进制时序）、自实现 ZIP 读写（zlib）、PowerShell CIM / WMI（Windows 指标）、`/proc`（Linux 指标）、自实现 SNMP BER 编解码与 MySQL/SQL Server/Redis wire 协议。前端为原生 JS + Canvas，需 Chrome 87+ / Edge 87+ / Firefox 78+。
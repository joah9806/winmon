# WinMon — 轻量级监控系统

类似 Zabbix 的轻量监控系统，面向 Windows 部署（**Windows 7 SP1 / 8.1 / 10 / 11 及 Linux**），**内置 Node.js 运行时，下载解压后双击即可运行**，无需安装任何环境。支持 Agent 深度采集与无代理探测两种方式，纯 Node.js 实现（无第三方依赖），数据存于自带的文件型存储引擎，深色中文 Web 界面，完全离线可用。

## 快速开始

1. 到 [Releases](../../releases) 下载 `winmon-server-windows.zip`。
2. 解压到任意目录，双击 `start.bat`（**默认后台运行，无残留 cmd 窗口**）。
3. 浏览器自动打开 `http://127.0.0.1:8686`。

停止服务：双击 `stop.bat`，或点 Web 界面右上角「停止服务」。重启服务：点右上角「重启服务」（短暂中断后自动恢复，页面自动刷新）。后台运行日志见 `data/server.log`。
如需前台控制台调试，用 `start-console.bat`。

## Windows 7 支持

Win7 SP1（32 位与 64 位）可直接运行，无需额外安装补丁或运行库：

| 项目 | 说明 |
|------|------|
| 运行时 | 内置 **Node.js 12.22.12**（最后一个支持 Win7 的 LTS）。`runtime/node.exe` 为 64 位，`runtime/node-x86.exe` 为 32 位，`pick-node.bat` 按系统位数自动选择 |
| 依赖库 | 不依赖 VC++ 运行库、.NET 4.x 或 PowerShell 3.0；HTTPS 使用 Node 自带的 OpenSSL 与 CA 证书，不受 Win7 系统 TLS 设置影响 |
| 指标采集 | `lib/collect.ps1` 优先用 CIM，检测到 PowerShell 2.0 时自动回退 `Get-WmiObject`，并手工拼装 JSON（PS 2.0 无 `ConvertTo-Json`） |
| 数据存储 | 纯 JS 存储引擎，不使用 `node:sqlite`（需 Node 22+）。**旧版 `data/monitor.db` 首次启动自动迁移**，见下文 |
| 打包脚本 | `make-package.js` 用 Node 自带的 zlib 生成 zip，替代 Win7 上不存在的 `Compress-Archive` |
| 浏览器 | Win7 最高可用 **Chrome 109.0.5414.120** 或 **Firefox 115 ESR**。**IE11 无法运行本界面** |

**关于 IE11**：Win7 自带的 IE11 缺少现代 JS/CSS 能力，无法渲染仪表盘。此时页面不会白屏，而会显示一张兼容指引页，列出缺失的能力、当前服务状态与局域网访问地址 —— 监控服务本身运行正常，可改用局域网内其它电脑/手机的浏览器访问，或在本机安装上表中的浏览器。

## 界面与运维
- **主题切换**：右上角「浅色/深色」按钮切换深浅主题，选择保存在浏览器本地，图表随主题重绘。
- **Web 停止/重启服务**：右上角「停止服务」「重启服务」按钮（均含确认弹窗），仅允许本机回环地址调用。重启会拉起新进程并自动接管端口，页面在恢复后自动刷新。
- **通知设置**：右上角「通知设置」按钮配置告警通知，支持 SMTP 邮件（SSL/STARTTLS/明文 + AUTH LOGIN）与 Webhook，可一键发送测试邮件。
- **主机管理（设备列表）**：原「探测配置」与「主机管理」合并为单一「主机管理」页。设备**按类型分组**显示（摄像机/交换机/防火墙/控制器/Linux/Windows/数据库/网络链路/应用/其他），组内**默认按 IP 数值排序**，顶部搜索框可按名称或 IP 即时过滤，无需再手动选择类型。
- **多选批量操作**：表格首列勾选框支持多选与全选，选中后出现批量操作栏，可批量修改（启用/停用、探测间隔、设备类型）与批量删除。
- **设备导入导出**：主机管理页支持 JSON / CSV 导入导出（见下文）。
- **主机详情管理**：在「概览」点击设备卡片进入详情，可重命名（Agent 主机）或编辑探测配置（探测设备），并删除主机。

> 运行时（`runtime/node.exe` 等）体积超过 GitHub 单文件限制，未纳入源码仓库，而是作为 Release 资产分发。克隆源码后需自行准备 `runtime/node.exe`（Node.js 12.22.12，Win7 兼容）与 `runtime/node-x86.exe`（32 位系统）才能运行。

## 监控能力

### 1. Agent 采集（服务器 / 电脑深度指标）
CPU、内存、磁盘、网络速率、进程数、运行时长。

- **Windows**（7 SP1 / 8.1 / 10 / 11，32 位或 64 位）：下载 `agent-windows.zip`，解压后修改 `config.json` 中 `agent.server_url` 指向服务端，双击 `agent.bat`（自动选择对应位数的运行时）。
- **Linux**：下载 `agent-linux.zip`（内置 Linux Node，基于 `/proc` 采集），解压后：
  ```sh
  chmod +x runtime/node agent.sh
  ./agent.sh
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
概览仪表盘、主机管理、告警中心、触发器。内置默认触发器（丢包过高、时延过高、端口不通、数据库连接失败、HTTP 异常、SNMP 不可达等），支持自定义阈值 / 持续次数 / 严重级，告警自动产生与恢复。告警触发与恢复时可推送 **SMTP 邮件**与 **Webhook** 通知（右上角「通知设置」）。删除设备会同步清除其概览卡片、历史数据与告警，不再残留。数据默认保留 7 天。

## 配置
编辑 `config.json`：
- `server.port`：Web 端口（默认 8686）
- `collection.interval_sec`：本机采集间隔
- `retention_days`：历史数据保留天数
- `token`：Agent 上报校验令牌（可选）
- `webhook_url`：告警 Webhook（可选）
- `mail`：SMTP 邮件通知，含 `enabled`、`host`、`port`、`secure`（`ssl`/`starttls`/`none`）、`user`、`pass`、`from`、`to`（多个收件人用逗号分隔）。推荐直接在 Web「通知设置」中填写并发送测试邮件，密码仅保存于服务端 `config.json`，接口不回传明文。

## 设备存储与导入导出
- 所有设备与历史数据保存在服务端目录的 **`data/`** 下（自带文件型存储引擎，无第三方依赖）：
  - `data/store.json`：设备与配置（Agent 主机 `hosts`、探测设备 `targets` / `checks`、触发器 `triggers`、告警 `alerts`），原子写入（临时文件 + 重命名）。
  - `data/history/h<主机ID>/<指标>.bin`：历史指标，按主机与指标分文件的定长二进制序列（每条 16 字节：时间戳 + 数值），范围查询用二分查找，绘图自动降采样。文件名用十六进制编码，避免 `disk.used_pct[C:]` 这类指标名中的 `:` 在 Windows 上非法。
  - 备份/迁移直接复制整个 `data/` 目录即可（建议先停止服务）。
- **从旧版 SQLite 自动迁移**：v1.4.0 及更早版本使用 `data/monitor.db`。升级后首次启动会自动读取该文件（含未落盘的 `-wal` 日志），把设备、触发器、告警与全部历史数据导入新引擎，随后把旧文件重命名为 `monitor.db.migrated` 保留备份，迁移只执行一次。迁移结果写入 `data/server.log`。
- **批量导入/导出**：在「主机管理」页工具栏提供 `导入` / `导出` 按钮：
  - 导出：JSON（完整备份，含探测参数）或 CSV（可用 Excel 编辑）。
  - 导入：支持上述 JSON 或 CSV；导入为**新增**，不覆盖现有设备。CSV 表头可点「下载 CSV 模板」获取。
  - 编码自动识别：导入 CSV 自动兼容 UTF-8（含 BOM）、GBK/ANSI（Excel 中文 Windows 默认另存格式）、UTF-16，中文名称不再乱码。
  - CSV 列：`name,type,address,interval_sec,enabled,ping,tcp_port,http_url,snmp_community,snmp_version,snmp_ifindex,snmp_cpu_oid,db_type,db_port,db_user,db_password,db_name,note`。
- **按类型分组**：「主机管理」页将设备按 摄像机/交换机/防火墙/控制器/Linux/Windows/数据库/网络链路/应用/其他 分组显示，每组带彩色标记与数量，组内按 IP 数值升序排列；顶部搜索框支持按名称或 IP 即时过滤。

## 目录结构
```
server.js        服务端（Web + API + 探测调度）
agent.js         Agent 上报端
lib/             采集 / 存储 / 告警 / 邮件通知 / SNMP / 数据库检测 / 探测引擎 / HTTP 客户端 / 打包
public/          Web 前端（原生 JS + Canvas，无外部依赖；compat.js 为 ES5 浏览器兼容闸门）
runtime/         内置 Node.js 运行时（Release 资产：node.exe / node-x86.exe / node-linux）
pick-node.bat    按系统位数选择运行时
*.bat / *.vbs    Windows 启动 / 停止 / 打包脚本
make-package.js  纯 Node 打包器（server / agent / linux）
agent.sh         Linux Agent 启动脚本
```

## 从源码打包
- Windows Agent：`make-agent.bat` → `agent-package.zip`（同时生成 Release 用的 `agent-windows.zip`）
- Linux Agent：`make-agent-linux.bat` → `agent-linux.zip`
- 完整服务端：`make-server.bat` → `winmon-server-windows.zip`
- 也可直接 `node make-package.js all` 一次生成全部资产。

## 技术栈
Node.js 12.22.12（Win7 兼容，自带 OpenSSL）、原生 HTTP/UDP/TCP、自实现文件型存储引擎（JSON 元数据 + 定长二进制时序）、自实现 ZIP 写入（zlib）、PowerShell CIM / WMI（Windows 指标）、`/proc`（Linux 指标）、自实现 SNMP BER 编解码与 MySQL/SQL Server/Redis wire 协议。前端为原生 JS + Canvas，需 Chrome 87+ / Edge 87+ / Firefox 78+。
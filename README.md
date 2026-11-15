# WinMon — 轻量级监控系统

类似 Zabbix 的轻量监控系统，面向 Windows 10 部署，**内置 Node.js 运行时，下载解压后双击即可运行**，无需安装任何环境。支持 Agent 深度采集与无代理探测两种方式，纯 Node.js 实现（无第三方依赖），数据存于内置 SQLite，深色中文 Web 界面，完全离线可用。

## 快速开始

1. 到 [Releases](../../releases) 下载 `winmon-server-windows.zip`。
2. 解压到任意目录，双击 `start.bat`（**默认后台运行，无残留 cmd 窗口**）。
3. 浏览器自动打开 `http://127.0.0.1:8686`。

停止服务：双击 `stop.bat`，或点 Web 界面右上角「停止服务」。后台运行日志见 `data/server.log`。
如需前台控制台调试，用 `start-console.bat`。

## 界面与运维
- **主题切换**：右上角「浅色/深色」按钮切换深浅主题，选择保存在浏览器本地，图表随主题重绘。
- **Web 关闭服务**：右上角「停止服务」按钮（含确认弹窗），仅允许本机回环地址调用，安全退出进程。
- **按类型筛选**：探测配置 / 主机管理可按设备类型筛选。
- **多选批量操作**：探测配置 / 主机管理表格首列勾选框支持多选与全选，选中后出现批量操作栏。探测配置可批量修改（启用/停用、探测间隔、设备类型）与批量删除；主机管理可批量修改（名称查找替换、探测设备启用/停用）与批量删除。
- **设备导入导出**：探测配置页支持 JSON / CSV 导入导出（见下文）。

> 运行时（`runtime/node.exe` 等）体积超过 GitHub 单文件限制，未纳入源码仓库，而是作为 Release 资产分发。克隆源码后需自行准备 `runtime/node.exe`（Node.js v24+）才能运行。

## 监控能力

### 1. Agent 采集（服务器 / 电脑深度指标）
CPU、内存、磁盘、网络速率、进程数、运行时长。

- **Windows**：下载 `agent-windows.zip`，解压后修改 `config.json` 中 `agent.server_url` 指向服务端，双击 `agent.bat`。
- **Linux**：下载 `agent-linux.zip`（内置 Linux Node，基于 `/proc` 采集），解压后：
  ```sh
  chmod +x runtime/node agent.sh
  ./agent.sh
  ```

### 2. 无代理探测（摄像机 / 交换机 / 防火墙 / 控制器 / 骨干网 / MV网 / 数据库 / 应用）
在「探测配置」页添加设备，按需勾选检查项：

| 检查 | 说明 |
|------|------|
| Ping | 可达性、时延、丢包率（任何 IP 设备，含链路） |
| TCP 端口 | 判断应用是否存活、端口响应时间 |
| HTTP | Web 服务状态码与响应时间 |
| SNMP v1/v2c | 接口入/出带宽、接口状态、设备运行时长、CPU |
| 数据库真实登录 | MySQL/MariaDB、SQL Server、Redis，用真实账号完成握手认证，判断数据库能否正常连接 |

## 告警与界面
概览仪表盘、探测配置、告警中心、触发器、主机管理。内置默认触发器（丢包过高、时延过高、端口不通、数据库连接失败、HTTP 异常、SNMP 不可达等），支持自定义阈值 / 持续次数 / 严重级，告警自动产生与恢复，可配 Webhook。数据默认保留 7 天。

## 配置
编辑 `config.json`：
- `server.port`：Web 端口（默认 8686）
- `collection.interval_sec`：本机采集间隔
- `retention_days`：历史数据保留天数
- `token`：Agent 上报校验令牌（可选）
- `webhook_url`：告警 Webhook（可选）

## 设备存储与导入导出
- 所有设备与历史数据保存在服务端目录的 **`data/monitor.db`**（SQLite 单文件数据库），不是普通文本文档：
  - 无代理探测设备 → `targets` / `checks` 表；Agent 主机 → `hosts` 表；历史指标 → `history` 表；告警 → `alerts` 表。
  - 备份/迁移直接复制 `data/monitor.db` 即可（建议先停止服务）。
- **批量导入/导出**：在「探测配置」页工具栏提供 `导入` / `导出` 按钮：
  - 导出：JSON（完整备份，含探测参数）或 CSV（可用 Excel 编辑）。
  - 导入：支持上述 JSON 或 CSV；导入为**新增**，不覆盖现有设备。CSV 表头可点「下载 CSV 模板」获取。
  - 编码自动识别：导入 CSV 自动兼容 UTF-8（含 BOM）、GBK/ANSI（Excel 中文 Windows 默认另存格式）、UTF-16，中文名称不再乱码。
  - CSV 列：`name,type,address,interval_sec,enabled,ping,tcp_port,http_url,snmp_community,snmp_version,snmp_ifindex,snmp_cpu_oid,db_type,db_port,db_user,db_password,db_name,note`。
- **按类型筛选**：「探测配置」与「主机管理」页工具栏均有类型下拉框，可按 摄像机/交换机/防火墙/控制器/Linux/Windows/数据库/网络链路/应用/Agent主机 筛选。

## 目录结构
```
server.js        服务端（Web + API + 探测调度）
agent.js         Agent 上报端
lib/             采集 / 存储 / 告警 / SNMP / 数据库检测 / 探测引擎
public/          Web 前端（原生 JS + Canvas，无外部依赖）
runtime/         内置 Node.js 运行时（Release 资产）
*.bat / *.vbs    Windows 启动 / 停止 / 打包脚本
agent.sh         Linux Agent 启动脚本
```

## 从源码打包 Agent
- Windows：`make-agent.bat` → `agent-package.zip`
- Linux：`make-agent-linux.bat` → `agent-linux.zip`

## 技术栈
Node.js v24（内置 `node:sqlite`）、原生 HTTP/UDP/TCP、PowerShell CIM（Windows 指标）、`/proc`（Linux 指标）、自实现 SNMP BER 编解码与 MySQL/SQL Server/Redis  wire 协议。
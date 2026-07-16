# 院校赛道决赛评分系统——部署与启动指南

更新日期：2026-07-15

本文档面向第一次接手本项目的同事。项目由 React/Vite 前端和一个 Node.js 共享评分服务组成；浏览器、平板和投屏设备都访问同一个 Node 服务地址。

## 1. 运行环境

请先安装：

- Node.js `22.12.0`（项目也允许 `>=22.12.0 <25`，正式环境建议严格使用 `.nvmrc` 指定的版本）
- npm（随 Node.js 安装）
- 正式部署时使用 MySQL `8.0`
- 可选：PM2，用于 Linux 服务器后台运行

检查版本：

```bash
node --version
npm --version
```

如果已经安装 nvm，可在项目目录执行：

```bash
nvm install
nvm use
```

所有后续命令都必须在包含 `package.json` 的项目根目录执行。

## 2. 解压后的首次检查

```bash
cd "<解压后的项目目录>"
node --version
npm ci
npm test
npm run build
```

必须使用 `npm ci`，不要先删除或修改 `package-lock.json`。`npm ci` 会严格按锁定版本安装依赖。

若只需要最快完成一次本机功能检查，可在 `npm ci` 后直接执行 `npm run contest`；该命令会先构建前端，再启动共享评分服务。

## 3. 本机或局域网试运行（文件存储）

本模式适用于开发、交接验收、临时演示和无 MySQL 的本机试运行，不用于正式决赛数据存储。

```bash
npm run contest
```

启动成功后，终端会显示：

```text
Contest scoring server listening on http://127.0.0.1:8776/
LAN access: http://<本机局域网IP>:8776/
```

本机浏览器访问：

```text
http://127.0.0.1:8776/
```

同一局域网内的平板或其他电脑必须访问终端输出的 `LAN access` 地址，不能使用 `127.0.0.1`。

验证服务：

```bash
curl -fsS http://127.0.0.1:8776/api/health
```

成功响应应包含：

```json
{"ok":true,"status":"ok","storage":"file"}
```

实际响应还会包含服务器时间和局域网地址。

停止服务：在启动服务的终端按 `Ctrl+C`。

### 本机试运行数据

- 状态文件：`data/contest-state.json`
- 审计日志：`data/logs/contest-server-YYYY-MM-DD.jsonl`
- 第一次启动时会自动创建缺失目录和初始数据。
- 如果需要全新的本机试运行状态，请先备份需要保留的数据，再执行 `npm run contest:fresh`。已有比赛残留时，该命令会拒绝启动，避免误以为数据已清空；正式比赛清场请严格按 `docs/final-competition-runbook.md` 操作。

## 4. 初始登录账号

- 评委账号：`001` 至 `007`
- 每个评委的初始密码与账号相同，例如账号 `001` 的密码为 `001`
- 管理员账号：`admin`
- 管理员初始密码：`admin123`

正式环境首次登录后必须立即修改管理员初始密码。生产模式会阻止使用未修改初始密码的管理员开启比赛组别。

## 5. 正式部署（Linux + 宿主机 MySQL 8.0）

正式决赛使用宿主机现有 MySQL 8.0，不要新增数据库 Docker 容器。应用只能保持一个 Node 写入进程，不能使用 PM2 cluster 或多副本部署。

### 5.1 初始化数据库

1. 打开 `scripts/mysql-schema.sql`。
2. 将其中两处 `change-this-password` 替换为同一个强密码。
3. 使用 MySQL 管理员执行：

```bash
mysql -uroot -p < scripts/mysql-schema.sql
```

该脚本会创建 `campus_final_scoring` 数据库、`contest_scoring` 用户以及当前版本所需的数据表。不要手工插入账号、密码哈希或评分记录；应用首次连接后会安全初始化账号和基础数据。

### 5.2 安装依赖并构建

```bash
cd "<服务器上的项目目录>"
nvm use
npm ci
npm test
npm run build
```

本交付包不携带 `node_modules/` 和 `dist/`；接收方应始终执行完整的 `npm ci && npm run build`，不要依赖发送方机器上的构建产物。

### 5.3 准备服务环境变量

将项目中的 `app.env.example` 复制到项目目录之外，例如：

```bash
sudo mkdir -p /opt/campus-final-scoring
sudo cp app.env.example /opt/campus-final-scoring/app.env
sudo chown "$(id -un):$(id -gn)" /opt/campus-final-scoring/app.env
sudo chmod 600 /opt/campus-final-scoring/app.env
sudo install -d -m 0750 -o "$(id -un)" -g "$(id -gn)" /opt/campus-final-scoring/logs
```

编辑 `/opt/campus-final-scoring/app.env`，至少替换 `CONTEST_MYSQL_PASSWORD`。不要把真实密码写回项目、压缩包或 Git。

加载变量：

```bash
set -a
source /opt/campus-final-scoring/app.env
set +a
```

首次初始化验证：

```bash
node contest-server.mjs
```

另开终端验证：

```bash
curl -fsS http://127.0.0.1:8776/api/health
```

正式 MySQL 响应必须包含 `"storage":"mysql"`。确认无报错后按 `Ctrl+C` 停止前台服务。

### 5.4 使用 PM2 单实例运行

安装 PM2：

```bash
npm install --global pm2
```

每次新开终端部署前，先加载上一节的环境变量，然后执行：

```bash
cd "<服务器上的项目目录>"
set -a
source /opt/campus-final-scoring/app.env
set +a
pm2 start ecosystem.config.cjs --env mysql
pm2 save
pm2 status
```

配置开机启动：

```bash
pm2 startup
```

`pm2 startup` 会输出一条需要管理员权限执行的命令；复制并执行它，然后再次执行 `pm2 save`。

查看运行状态和日志：

```bash
pm2 status
pm2 logs campus-final-scoring --lines 100
curl -fsS http://127.0.0.1:8776/api/health
```

安全重启：

```bash
cd "<服务器上的项目目录>"
set -a
source /opt/campus-final-scoring/app.env
set +a
pm2 restart ecosystem.config.cjs --env mysql --update-env
```

停止服务：

```bash
pm2 stop campus-final-scoring
```

### 5.5 正式空场启动门禁

`REQUIRE_EMPTY_STATE=1` 只用于确认正式场次开始前不存在彩排评分、当前派发、已发布投屏、锁定名册或队伍评分快照残留：

```bash
set -a
source /opt/campus-final-scoring/app.env
set +a
REQUIRE_EMPTY_STATE=1 node contest-server.mjs
```

检查通过后停止该前台进程，再按 PM2 步骤正常启动。不要把 `REQUIRE_EMPTY_STATE=1` 长期写入 PM2 环境；比赛开始后存在正常评分数据，带该变量的进程重启会被门禁拒绝。

正式清场不是简单删除评分表。必须先备份，再按 `docs/final-competition-runbook.md` 对彩排开启过的各组执行“应急处置 → 重新配置当前组”，最后使用上述门禁复核。

## 6. 可选 Docker 部署

项目的 `Dockerfile` 只打包 Node 应用，正式数据库仍是宿主机 MySQL 8.0。完整命令和备份、回滚要求见：

```text
docs/docker-server-deploy-guide.md
```

本机可先验证镜像：

```bash
npm run check:docker
```

Linux 服务器上使用 Docker 时，只运行一个应用容器，并使用 host 网络访问宿主机 MySQL。这样容器内的 `127.0.0.1` 与 schema 中为 `contest_scoring` 配置的 localhost/127.0.0.1 授权一致：

```bash
docker build -t campus-final-scoring:latest .
docker rm -f campus-final-scoring 2>/dev/null || true
docker run -d \
  --name campus-final-scoring \
  --restart unless-stopped \
  --network host \
  --env-file /opt/campus-final-scoring/app.env \
  -v /opt/campus-final-scoring/logs:/opt/campus-final-scoring/logs \
  campus-final-scoring:latest
curl -fsS http://127.0.0.1:8776/api/health
```

不要用 Docker 启动 MySQL 容器，不要使用 bridge 网络绕过数据库授权，也不要启动第二个应用容器。

## 7. 端口与网络

- 默认监听：`0.0.0.0:8776`
- 本机健康检查：`http://127.0.0.1:8776/api/health`
- 局域网设备入口：启动日志中的 `LAN access` 地址
- 服务器防火墙只向受控比赛网络开放 `8776`，或通过反向代理提供 HTTPS
- 所有管理员、评委和平板投屏设备必须访问同一台服务器

检查端口是否被占用：

```bash
lsof -nP -iTCP:8776 -sTCP:LISTEN
```

Linux 也可使用：

```bash
ss -ltnp | grep ':8776'
```

## 8. 常见问题

### `npm ci` 报 Node 版本不支持

执行 `node --version`，切换到 Node `22.12.0` 后重新运行 `npm ci`。

### 启动时报 `EADDRINUSE`

端口 `8776` 已被其他进程占用。先用上一节命令找到旧进程，确认后停止旧服务；不要同时运行两个评分服务实例。

### 正式启动尝试连接 MySQL 但失败

检查 `CONTEST_STORAGE=mysql`、数据库地址、端口、库名、账号和密码，并确认 MySQL 用户拥有 `SELECT`、`INSERT`、`UPDATE`、`DELETE`、`CREATE`、`INDEX`、`ALTER`、`REFERENCES` 权限。

### 平板打不开，但服务器本机可以打开

确认平板和服务器在同一受控网络，使用 `LAN access` 地址而非 `127.0.0.1`，并检查主机防火墙是否允许 TCP `8776`。

### 健康检查显示 `storage_unavailable`

文件模式下检查项目目录的写权限；MySQL 模式下检查数据库服务、账号权限和连接参数。先恢复存储，再允许评委继续操作。

## 9. 正式交接必读

- `docs/dependency-installation.md`：npm install、Node/npm、MySQL、PM2、Docker 和环境变量配置
- `docs/final-quick-guide.md`：现场一分钟操作卡
- `docs/final-competition-runbook.md`：赛前、每队流程、应急、备份与赛后操作
- `docs/mysql-deployment.md`：MySQL 初始化、Smoke Test、备份与恢复
- `docs/docker-server-deploy-guide.md`：Docker 应用部署
- `docs/README.md`：正式文档索引

压缩交付包刻意不包含 `node_modules/`、`.git/`、本机 `.npmrc`、`data/`、审计日志、测试产物、历史数据库导出和旧 Docker 镜像。解压后按本文档执行 `npm ci` 即可恢复依赖。

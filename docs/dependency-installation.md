# 依赖安装与环境变量配置

这份文档用于新同事拿到项目压缩包后的快速准备。所有命令都在项目根目录执行，也就是能看到 package.json、package-lock.json 和 contest-server.mjs 的目录。

## 1. 安装 Node.js 和 npm

项目要求 Node.js 22.12.0，版本范围为 >=22.12.0 <25。推荐使用 nvm：

    nvm install 22.12.0
    nvm use 22.12.0
    node --version
    npm --version

node --version 应输出 v22.12.0。若没有 nvm，请先安装 Node.js 22.12.0，再继续下面的命令。

## 2. 安装项目 npm 依赖

首次安装或需要按照 package.json 重新解析依赖时执行：

    cd "/path/to/院校赛道决赛评分平板端"
    npm install

本项目的 npm 依赖分为两类：

- 运行依赖：mysql2，用于正式 MySQL 存储。
- 构建和测试依赖：React、React DOM、Vite、@vitejs/plugin-react、lucide-react、@dnd-kit/*、Playwright。

安装完成后，执行构建和测试：

    npm run build
    npm test

正式服务器或 CI 环境已有 package-lock.json 时，优先使用可复现安装：

    npm ci

npm install 适合第一次准备环境；npm ci 会删除并重建 node_modules，且严格使用 package-lock.json。不要手工删除或修改 package-lock.json。

## 3. 可选的全局工具

正式 Linux 服务器使用 PM2 常驻 Node 服务时，额外安装：

    npm install --global pm2
    pm2 --version

Docker 部署不需要全局安装 PM2，但服务器需要 Docker Engine：

    docker --version

MySQL 正式部署需要 MySQL 8.0 客户端和服务端：

    mysql --version

这些工具不是项目 npm 依赖，不会由 npm install 自动安装。

## 4. 环境变量文件

项目提供 app.env.example 作为模板。应用不会自动读取这个文件，必须先复制到项目目录之外，替换密码后再加载。

正式 Linux 服务器：

    sudo mkdir -p /opt/campus-final-scoring
    sudo cp app.env.example /opt/campus-final-scoring/app.env
    sudo chmod 600 /opt/campus-final-scoring/app.env

编辑 /opt/campus-final-scoring/app.env，至少确认这些变量：

    NODE_ENV=production
    HOST=0.0.0.0
    PORT=8776
    CONTEST_STORAGE=mysql
    CONTEST_MYSQL_HOST=127.0.0.1
    CONTEST_MYSQL_PORT=3306
    CONTEST_MYSQL_DATABASE=campus_final_scoring
    CONTEST_MYSQL_USER=contest_scoring
    CONTEST_MYSQL_PASSWORD=替换为正式数据库密码
    CONTEST_MYSQL_TABLE_PREFIX=contest_final_
    CONTEST_REQUIRE_ADMIN_PASSWORD_ROTATION=1
    CONTEST_LOG_DIR=/opt/campus-final-scoring/logs

加载环境变量并检查关键变量：

    set -a
    source /opt/campus-final-scoring/app.env
    set +a
    test "$CONTEST_STORAGE" = mysql
    test -n "$CONTEST_MYSQL_PASSWORD"
    printf 'storage=%s host=%s port=%s database=%s\n' \
      "$CONTEST_STORAGE" "$CONTEST_MYSQL_HOST" "$CONTEST_MYSQL_PORT" "$CONTEST_MYSQL_DATABASE"

不要把真实密码提交到 Git、写入 app.env.example、放进压缩包或打印到日志。

## 5. MySQL 依赖准备

正式运行前，先启动宿主机 MySQL 8.0，并在项目根目录执行：

    mysql --version
    mysql -uroot -p < scripts/mysql-schema.sql

这个脚本会创建数据库、contest_scoring 应用账号、表和权限。执行前把脚本中的 change-this-password 替换为正式数据库密码，并确保它与 CONTEST_MYSQL_PASSWORD 相同。

确认应用账号可以连接：

    mysql -h 127.0.0.1 -P 3306 \
      -u "$CONTEST_MYSQL_USER" -p "$CONTEST_MYSQL_DATABASE"

如果使用 Docker 运行应用，仍使用宿主机 MySQL，不要额外启动 MySQL 容器。Linux Docker 应用按 DEPLOYMENT.md 使用 host 网络运行。

## 6. 本机快速启动

不需要 MySQL 的页面评审使用文件存储：

    CONTEST_STORAGE=file \
    CONTEST_DATA_DIR="$(mktemp -d)" \
    CONTEST_LOG_DIR="$(mktemp -d)" \
    npm run contest

访问 http://127.0.0.1:8776/，另开终端检查：

    curl --fail http://127.0.0.1:8776/api/health

正式共享评分服务必须使用第 4、5 节的 MySQL 环境变量，然后执行：

    set -a
    source /opt/campus-final-scoring/app.env
    set +a
    npm run build
    node contest-server.mjs

看到 storage=mysql 的健康检查响应后，再交给管理员、评委平板和投屏设备使用启动日志里的 LAN access 地址。

## 7. 安装完成验收

依赖和环境准备完成后执行：

    node --version
    npm --version
    npm run build
    npm test

正式 MySQL 服务另开终端执行：

    curl --fail http://127.0.0.1:8776/api/health

预期：

- 构建命令成功并生成 dist/。
- npm test 全部通过。
- 正式服务健康响应包含 "ok":true、"status":"ok" 和 "storage":"mysql"。
- 本机文件模式健康响应的 storage 为 file。
- 所有设备访问同一个服务的 LAN access 地址。

常用入口：

- [完整部署](../DEPLOYMENT.md)
- [环境变量模板](../app.env.example)
- [MySQL 部署](mysql-deployment.md)
- [Docker 应用部署](docker-server-deploy-guide.md)


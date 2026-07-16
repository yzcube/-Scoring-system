# Docker 多阶段镜像依赖研究

日期：2026-07-13

## 研究问题

评分规则和服务端模块从 `src/` 拆分到 `shared/`、`domain/`、`server/` 后，现有多阶段 `Dockerfile` 是否仍能构建并启动服务。

## 一手依据

- Docker 将构建上下文定义为构建指令可访问的文件集合；`COPY` 和 `ADD` 只能引用该上下文中的路径。[Docker Build context](https://docs.docker.com/build/concepts/context/)
- `COPY` 的上下文源路径相对于上下文根目录解析；`COPY --from=<stage>` 则从指定镜像或构建阶段的文件系统根目录解析。[Dockerfile `COPY` reference](https://docs.docker.com/reference/dockerfile/#copy)
- 第二个 `FROM` 会开启新的阶段；最终镜像只包含显式复制进该阶段的内容，前一阶段的文件不会自动保留。[Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/)

## 修复前证据

重构前的 [Dockerfile](../Dockerfile) build 阶段仅复制 `src/`，但 [src/App.jsx](../src/App.jsx) 已导入 `../shared/scoringRules.js`。由于 `/app/shared/scoringRules.js` 未出现在 build 阶段，这会使 `npm run build` 的模块解析失败。

重构前 runtime 阶段只复制 `contest-server.mjs`、`src/` 和 build 产物 `dist/`。但 [contest-server.mjs](../contest-server.mjs) 在启动时还导入：

```text
./shared/scoringRules.js
./domain/contestControl.js
./server/auth-session.mjs
./server/state-store.mjs
./server/http-routes.mjs
./server/session-api-routes.mjs
```

因此，即使绕过前端构建，重构前运行镜像也会在 Node ESM 模块解析阶段失败。当前 [.dockerignore](../.dockerignore) 没有排除这些目录，问题是 Dockerfile 没有把它们复制进相应阶段，而不是构建上下文不可见。

## 修复结果与验证约束

1. build 阶段现在包含 `shared/`、`domain/`、`server/` 和 `contest-server.mjs`；runtime 从命名为 `build` 的阶段复制 `src/`、`shared/`、`domain/`、`server/`、入口和 `dist/`，使运行源码与刚刚构建的前端产物同源。
2. runtime 使用仓库 `package-lock.json` 执行 `npm ci --omit=dev`，避免运行依赖在构建时漂移。
3. `npm run check:docker` 会执行真实镜像构建，以隔离文件存储启动容器，请求 `/api/health` 与 `/scoreboard`，并等待 Docker 自身报告 `healthy`。仅运行宿主机 `npm run build` 不能证明 Docker 两阶段文件图完整。

## 非目标

本研究不建议在镜像中增加 MySQL 容器，也不改变现有“宿主 MySQL + 单 Node 进程”的决赛部署约束。

# 决赛评分文档入口

更新日期：2026-07-14

## 正式比赛只使用以下文档

0. [交付与部署文档](../DEPLOYMENT.md)：新同事从压缩包解压、安装环境、启动服务和验收的完整入口。
1. [依赖安装与环境变量](./dependency-installation.md)：npm install、Node/npm、MySQL、PM2、Docker 和 app.env.example 配置。
2. [启动说明](./startup.md)：开发、正式 MySQL 启动、设备入口和生产限制。
3. [现场 Runbook](./final-competition-runbook.md)：赛前验收、每队操作、应急和备份。
4. [现场一分钟操作卡](./final-quick-guide.md)：管理员和评委在比赛现场的最短操作路径。
5. [MySQL 部署](./mysql-deployment.md)：初始化、smoke、正式启动、备份和恢复。
6. [Docker/服务器部署](./docker-server-deploy-guide.md)：容器与服务器部署路径。

若上述文档与其他审计或研究记录冲突，以本页列出的正式文档和根目录 `AGENTS.md` 为准。

## 领域口径

比赛术语以根目录 [CONTEXT.md](../CONTEXT.md) 为准。特别注意：

- “本场评委”属于开赛配置。
- “计划评分名册”只影响下一支尚未形成快照的队伍。
- “队伍评分快照”决定当前队和历史队的评分口径。
- 当前队换人使用“当前队评委替换”，不能通过计划名册补人。
- 整组人数或队伍范围错误才使用“应急重新开赛”。

## 研究与历史审计

文件名包含 `research`、`audit`、`inspection`、`refactor` 的文档用于保留设计证据和历史问题，不作为现场操作说明。它们可能包含早期账号、已删除界面或文件模式架构描述。

本轮断言与回归门禁的证据、官方资料和实施结果见 [回归断言质量与门禁研究](./assertion-quality-research-2026-07-14.md)。

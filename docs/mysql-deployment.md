# MySQL Final Deployment

Updated: 2026-07-13

## Storage Model

The final service uses the host MySQL 8.0 instance. Do not add a database Docker container. Run one Node process only; PM2 must use `exec_mode: fork` and `instances: 1`.

Set these environment variables for the service:

```bash
CONTEST_STORAGE=mysql
CONTEST_MYSQL_HOST=127.0.0.1
CONTEST_MYSQL_PORT=3306
CONTEST_MYSQL_DATABASE=campus_final_scoring
CONTEST_MYSQL_USER=contest_scoring
CONTEST_MYSQL_PASSWORD='<strong-password>'
CONTEST_MYSQL_TABLE_PREFIX=contest_final_
```

`CONTEST_DATABASE_URL` may be used instead of the separate MySQL connection values.

The current model stores these first-class resources:

- `contest_final_teams`: team identity, display information, order, status, revision, and locked roster snapshot.
- `contest_final_accounts`: account metadata, password hashes, account revision, and authentication version.
- `contest_final_account_sessions`: opaque-token hashes, device labels, expiry, and revocation state for independent device sessions.
- `contest_final_audit_events`: durable critical events written in the same transaction as temporary judge enrollment.
- `contest_final_judge_roster`: current roster membership and order.
- `contest_final_entries`: changed score entries only, with entry revisions.
- `contest_final_control_state`: roster metadata including durable enrollment idempotency records, active assignment, score-display publication, and per-group order revisions. `control_value` uses `MEDIUMTEXT` so the retained operation history does not hit the 64 KiB `TEXT` limit.

The legacy `candidate_overrides` and `candidate_order` tables are retained only for a one-time older-schema migration. Normal runtime reads the tables above.

## First Initialization

The app account needs `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `INDEX`, `ALTER`, and `REFERENCES` privileges. Update the placeholder password in [mysql-schema.sql](../scripts/mysql-schema.sql), then create the database objects:

```bash
mysql -uroot -p < scripts/mysql-schema.sql
```

Build and start the service once. It creates the initial 80 teams, eight accounts, the seven-judge roster, and salted password hashes. Do not manually insert account rows or password hashes.

```bash
npm ci
npm run build
CONTEST_STORAGE=mysql \
CONTEST_REQUIRE_ADMIN_PASSWORD_ROTATION=1 \
CONTEST_MYSQL_HOST=127.0.0.1 \
CONTEST_MYSQL_DATABASE=campus_final_scoring \
CONTEST_MYSQL_USER=contest_scoring \
CONTEST_MYSQL_PASSWORD='<strong-password>' \
node contest-server.mjs
```

Stop that initial process before importing a previous competition state. Reset the default administrator password before public network use.

## State Migration

`db:import-state` performs a full v4 disaster-recovery replacement: accounts and password hashes, teams, entries, roster, and control state are restored as one transaction. Accounts absent from the backup are removed, and all sessions are revoked. The backup is sensitive credential material. This command is a full restore operation, not a rehearsal-clear command.

Preview a migration first:

```bash
npm run db:import-state -- --dry-run
```

After verifying the source summary, replace the competition state:

```bash
CONTEST_MYSQL_HOST=127.0.0.1 \
CONTEST_MYSQL_DATABASE=campus_final_scoring \
CONTEST_MYSQL_USER=contest_scoring \
CONTEST_MYSQL_PASSWORD='<strong-password>' \
npm run db:import-state -- --replace --yes
```

The import validates that every roster, snapshot, or scoring judge exists in the source account set and that an active administrator is present. It replaces the target account identity set exactly. For older JSON state, first start the file-mode server once so it migrates the file to v4.

`db:export-sql` creates a full state-replacement SQL file including salted password hashes but excluding active sessions. Encrypt it and restrict access. It is not a substitute for a full MySQL backup with audit logs:

```bash
npm run db:export-sql
```

`db:export-additive-group` only inserts missing team entities for a group. It does not alter entries, accounts, roster, current assignment, or display publication:

```bash
npm run db:export-additive-group -- --group zhongzhi
```

The older checked-in `database-export/campus-final-scoring-simulated-data.sql` and its compressed copy are legacy pre-v4 fixtures and must not be imported into the current schema. Use `db:export-sql` or `db:export-additive-group` to generate current-schema SQL instead.

## MySQL Smoke Test

Run the MySQL smoke test against a non-production schema after configuring its credentials:

```bash
CONTEST_MYSQL_HOST=127.0.0.1 \
CONTEST_MYSQL_DATABASE=campus_final_scoring \
CONTEST_MYSQL_USER=contest_scoring \
CONTEST_MYSQL_PASSWORD='<strong-password>' \
npm run check:mysql
```

It uses the guarded `contest_smoke_` table prefix and checks entity initialization, assignment dispatch, score revision conflict, seven submissions, final display publication, restart recovery of roster lock metadata, rejection of an in-progress contest by `REQUIRE_EMPTY_STATE=1`, and successful formal-mode startup after emergency reset. It must never target the `contest_final_` production prefix.

## Formal Start

For a formal empty round, start with `REQUIRE_EMPTY_STATE=1`:

```bash
CONTEST_STORAGE=mysql \
CONTEST_MYSQL_HOST=127.0.0.1 \
CONTEST_MYSQL_DATABASE=campus_final_scoring \
CONTEST_MYSQL_USER=contest_scoring \
CONTEST_MYSQL_PASSWORD='<strong-password>' \
REQUIRE_EMPTY_STATE=1 \
node contest-server.mjs
```

The service refuses startup if score entries, team roster snapshots, an opened/closed group, a current assignment, a published display selection, or a locked roster remains. Team display details, appearance order, accounts, and the planned roster are preserved. After the clean start, the administrator must configure and open the formal group before dispatching its first team.

## Backup And Rehearsal Clear

Back up all operational resources and JSONL audit logs before any clear or migration:

```bash
mkdir -p backups
mysqldump --single-transaction --quick -uroot -p campus_final_scoring \
  contest_final_teams \
  contest_final_accounts \
  contest_final_account_sessions \
  contest_final_judge_roster \
  contest_final_entries \
  contest_final_control_state \
  contest_final_audit_events \
  > "backups/campus-final-$(date +%Y%m%d-%H%M%S).sql"
```

恢复后先执行 `DELETE FROM contest_final_account_sessions;`，再启动服务并让所有设备重新登录。应用状态 SQL 导出包含账号密码哈希，属于敏感灾备文件，必须加密保存并限制访问。

For rehearsal cleanup, first use the administrator's “应急处置 → 重新配置当前组” action for every group that was opened during rehearsal. This atomically clears that group's entries and team roster snapshots and returns its control state to draft. Back up first and verify each affected group explicitly.

Only after every rehearsed group has returned to draft may operations remove any remaining score-entry rows:

```sql
USE campus_final_scoring;
DELETE FROM contest_final_entries;
```

Do not delete `teams`, `accounts`, `judge_roster`, or `control_state`. Start once with `REQUIRE_EMPTY_STATE=1`; startup must fail if any assignment, display, roster-lock, group-status, or team-snapshot residue remains. Never treat a successful `DELETE FROM entries` alone as a complete formal-round reset.

## Operational Notes

- Production must use the host MySQL service and a single Node writer. Do not use PM2 cluster or multiple processes against the same score tables.
- `data/contest-state.json` is file-mode development or review fallback only. It is not the final cloud source of truth.
- JSONL audit logs are kept outside MySQL. Back up `data/logs/` (or `CONTEST_LOG_DIR`) alongside database backups.
- The built-in seed passwords are initialization credentials for the controlled LAN workflow. Reset administrator credentials before unrestricted access and keep the final network isolated.

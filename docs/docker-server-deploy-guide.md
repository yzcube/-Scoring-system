# Docker Application Deployment

Updated: 2026-07-13

This guide deploys only the Node application container. The final database remains the existing host MySQL 8.0 service. Do not add a database container, and do not run more than one application writer.

## Preconditions

- The server has the host MySQL database initialized with [mysql-schema.sql](../scripts/mysql-schema.sql).
- The application has been started once with `CONTEST_STORAGE=mysql` so it seeded secure account hashes and control records.
- A current MySQL backup and JSONL audit-log backup exist.
- The deployed image contains the current built `dist/` files.

The current persistent tables are:

```text
contest_final_teams
contest_final_accounts
contest_final_account_sessions
contest_final_judge_roster
contest_final_entries
contest_final_control_state
contest_final_audit_events
```

Do not use old `candidates`, `candidate_overrides`, or `candidate_order` table instructions for normal operations.

## Local Verification

```bash
npm ci
npm run check:daily
npm run build
npm run check:docker
```

`check:docker` builds the application image and starts it briefly with isolated file storage before requesting `/api/health` and waiting for Docker's own `healthy` state. It verifies the multi-stage image contains both the built frontend and every server-side ESM dependency. It does not replace the MySQL smoke test below.

When non-production MySQL credentials are available, also run:

```bash
CONTEST_MYSQL_HOST=127.0.0.1 \
CONTEST_MYSQL_DATABASE=campus_final_scoring \
CONTEST_MYSQL_USER=contest_scoring \
CONTEST_MYSQL_PASSWORD='<test-password>' \
npm run check:mysql
```

## Build And Transfer

Build an amd64 image when the server is amd64:

```bash
IMAGE_TAG=20260713-admin-control
docker buildx build \
  --platform linux/amd64 \
  -t campus-final-scoring:${IMAGE_TAG} \
  --load .

mkdir -p docker-export
docker save campus-final-scoring:${IMAGE_TAG} | gzip -c > docker-export/campus-final-scoring-${IMAGE_TAG}-amd64.tar.gz
shasum -a 256 docker-export/campus-final-scoring-${IMAGE_TAG}-amd64.tar.gz
```

Transfer the image to the server and verify its checksum before loading it:

```bash
scp docker-export/campus-final-scoring-${IMAGE_TAG}-amd64.tar.gz root@<server>:/opt/campus-final-scoring/
ssh root@<server>
cd /opt/campus-final-scoring
sha256sum campus-final-scoring-${IMAGE_TAG}-amd64.tar.gz
gzip -cd campus-final-scoring-${IMAGE_TAG}-amd64.tar.gz | docker load
```

## Server Environment

Keep secrets in a server-only file such as `/opt/campus-final-scoring/app.env` with mode `0600`:

```bash
NODE_ENV=production
HOST=0.0.0.0
PORT=8776
CONTEST_STORAGE=mysql
CONTEST_MYSQL_HOST=127.0.0.1
CONTEST_MYSQL_PORT=3306
CONTEST_MYSQL_DATABASE=campus_final_scoring
CONTEST_MYSQL_USER=contest_scoring
CONTEST_MYSQL_PASSWORD=<server-only-password>
CONTEST_MYSQL_TABLE_PREFIX=contest_final_
CONTEST_LOG_DIR=/opt/campus-final-scoring/logs
```

Do not commit, upload to source control, or print this file. The app user must have the MySQL privileges documented in [mysql-deployment.md](./mysql-deployment.md).

## Single-Instance Start Or Update

Create a backup before replacing the running container:

```bash
mkdir -p /opt/campus-final-scoring/backups
mysqldump --single-transaction --quick -uroot -p campus_final_scoring \
  > "/opt/campus-final-scoring/backups/before-${IMAGE_TAG}-$(date +%Y%m%d-%H%M%S).sql"
```

The pre-update command dumps the whole database so it also works when upgrading from a version that has not created `contest_final_audit_events` yet. After the new single instance starts, verify that the audit table exists before the next operational backup.

Run exactly one container. `--network host` lets the container reach host MySQL at `127.0.0.1`; do not publish a second application container or use a database container.

```bash
docker rm -f campus-final-scoring 2>/dev/null || true
docker run -d \
  --name campus-final-scoring \
  --restart unless-stopped \
  --network host \
  --env-file /opt/campus-final-scoring/app.env \
  -v /opt/campus-final-scoring/logs:/opt/campus-final-scoring/logs \
  campus-final-scoring:${IMAGE_TAG}
```

Verify service health and logs:

```bash
curl -fsS http://127.0.0.1:8776/api/health
docker logs --tail 100 campus-final-scoring
```

The API health response must report `"storage":"mysql"`. Confirm that the started log names the six current MySQL tables.

## Formal Round And Rollback

For a formal empty round, first back up the database. In the administrator UI, use “应急处置 → 重新配置当前组” for every group opened during rehearsal. Only after all such groups are back in draft may any remaining score rows be removed with:

```sql
DELETE FROM contest_final_entries;
```

This preserves team data, accounts, planned roster, and draw order while the UI action also clears team snapshots and active control metadata. Add `REQUIRE_EMPTY_STATE=1` to `app.env`; startup must reject any remaining assignment, display, group-status, roster-lock, or team-snapshot residue. Then configure/open the formal group and explicitly dispatch its first team.

To roll back application code, stop the current container and start the earlier image with the same environment and database. Do not restore a database backup unless the operational lead has approved a data rollback; application rollback and score-data rollback are separate decisions.

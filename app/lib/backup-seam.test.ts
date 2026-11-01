/**
 * Backup CronJob seam guard (roadmap item 3, "Backup CronJob (disaster
 * recovery)").
 *
 * The nightly backup cannot be reached from a unit test: it is a Helm
 * template, a Dockerfile stage and a bash script whose job is to talk to a real
 * PVC and a real ssh host. What CAN regress silently is the wiring, so these
 * assertions pin the parts that would make the job useless or dangerous:
 *
 *  - the chart gates the CronJob behind backup.enabled (off by default), and
 *    refuses to render an enabled job with no ssh Secret name
 *  - the /data claim is mounted READ-ONLY in both the volume and the mount
 *    (the app is the single writer; a backup pod must never write it)
 *  - the job runs in an image that actually has ssh + rsync (the app runtime
 *    image does not), while `--target runtime` still yields the app image
 *  - the script uses the SQLite-safe helper, carries the migration journal
 *    (without it a restore replays 0000_init and dies), pins host keys, and
 *    keeps 14 days
 *
 * Source-assertion style, like app/lib/read.test.ts: no DB, no network.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve a repo-relative path from this test file (app/lib/...). */
function repoFile(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

function read(relative: string): string {
  return fs.readFileSync(repoFile(relative), "utf8");
}

/** The indented block that starts at the line `header` and ends at the next dedent. */
function blockAfter(source: string, header: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  expect(start).toBeGreaterThan(-1);
  const base = lines[start]!.length - lines[start]!.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      body.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= base) break;
    body.push(line);
  }
  return body.join("\n");
}

describe("helm backup CronJob", () => {
  const cronJob = read("helm/recipedb/templates/backup-cronjob.yaml");

  it("is gated on backup.enabled (opt-in, never on by default)", () => {
    expect(cronJob).toMatch(/\{\{-\s*if\s+\.Values\.backup\.enabled\s*\}\}/);
    // The whole resource is inside the guard, so `end` must be the last thing.
    expect(cronJob.trimEnd().endsWith("{{- end }}")).toBe(true);
  });

  it("fails the render when enabled without an ssh Secret name", () => {
    expect(cronJob).toMatch(
      /required\s+"backup\.sshSecretName is required[^"]*"\s+\.Values\.backup\.sshSecretName/,
    );
  });

  it("mounts the data claim read-only in both the volume and the mount", () => {
    const mounts = blockAfter(cronJob, "volumeMounts:");
    expect(mounts).toMatch(/mountPath:\s*\{\{\s*\.Values\.env\.DATA_DIR[^}]*\}\}/);
    expect(mounts).toMatch(/readOnly:\s*true/);

    const volumes = blockAfter(cronJob, "volumes:");
    expect(volumes).toContain("persistentVolumeClaim:");
    expect(volumes).toContain('claimName: {{ include "recipedb.dataVolume" . }}');
    expect(volumes).toMatch(/readOnly:\s*true/);
  });

  it("mounts the key + known_hosts from a Secret at 0400", () => {
    expect(cronJob).toContain("defaultMode: 0400");
    expect(cronJob).toContain(".Values.backup.secretKeys.privateKey");
    expect(cronJob).toContain(".Values.backup.secretKeys.knownHosts");
    expect(cronJob).toMatch(/mountPath:\s*\/secrets/);
    expect(cronJob).toContain("secretName: {{ $sshSecret }}");
  });

  it("runs the backup image stage (ssh tooling), not the app image tag", () => {
    // <image.tag>-backup unless overridden; the app image has no ssh client.
    expect(cronJob).toMatch(/printf\s+"%s-backup"\s+\$appTag/);
    expect(cronJob).toContain('.Values.backup.image.tag | default');
    expect(cronJob).toContain('command: ["/bin/bash", "/app/backup-k8s.sh"]');
  });

  it("passes host/path/retention through and never overlaps runs", () => {
    expect(cronJob).toContain("BACKUP_HOST");
    expect(cronJob).toContain(".Values.backup.path");
    expect(cronJob).toContain("RETENTION_DAYS");
    expect(cronJob).toContain("concurrencyPolicy: Forbid");
  });
});

describe("backup image stage", () => {
  const dockerfile = read("Dockerfile");

  it("adds a backup stage on top of runtime with ssh + rsync", () => {
    expect(dockerfile).toMatch(/^FROM runtime AS backup$/m);
    const stage = dockerfile.slice(dockerfile.indexOf("FROM runtime AS backup"));
    const beforeDevelopment = stage.slice(0, stage.indexOf("AS development"));
    expect(beforeDevelopment).toContain("openssh-client");
    expect(beforeDevelopment).toContain("rsync");
    expect(beforeDevelopment).toContain("deploy/backup.cjs");
    expect(beforeDevelopment).toContain("deploy/backup-k8s.sh");
    expect(beforeDevelopment).toMatch(/USER node/);
  });

  it("keeps the app stages unchanged -- runtime is still the app image", () => {
    expect(dockerfile).toContain("CMD [\"node\", \"server.js\"]");
    // The app image must not grow ssh: the clean-up keeps apt lists out.
    // Instruction lines only: the explanatory comment above the backup stage
    // mentions the tools it adds.
    const runtime = dockerfile
      .slice(
        dockerfile.indexOf("FROM node:26.10.0-bookworm-slim AS runtime"),
        dockerfile.indexOf("FROM runtime AS backup"),
      )
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(runtime).not.toContain("openssh-client");
    expect(runtime).not.toContain("rsync");
    // `docker build` with no --target must still produce the dev stage.
    expect(dockerfile.trimEnd().endsWith("CMD [\"npm\", \"run\", \"dev\"]")).toBe(true);
  });
});

describe("deploy/backup-k8s.sh", () => {
  const script = read("deploy/backup-k8s.sh");

  it("is strict-mode bash", () => {
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(script).toContain("set -euo pipefail");
  });

  it("uses the SQLite-safe helper, never a raw copy", () => {
    expect(script).toContain('node "$BACKUP_CJS"');
    expect(script).toContain("/app/backup.cjs");
    expect(script).not.toMatch(/\bcp\s+"\$DATA_DIR\/recipes\.db"/);
  });

  it("captures images and the migration journal", () => {
    expect(script).toContain("migrations-applied.json");
    expect(script).toMatch(/tar -czf/);
    expect(script).toContain("images-$STAMP.tar.gz");
  });

  it("pins the host key and ships over ssh", () => {
    expect(script).toContain("StrictHostKeyChecking=yes");
    expect(script).toContain("BatchMode=yes");
    expect(script).toContain("UserKnownHostsFile=");
    expect(script).toContain("rsync -e");
  });

  it("prunes remote artifacts past RETENTION_DAYS", () => {
    expect(script).toContain('RETENTION_DAYS="${RETENTION_DAYS:-14}"');
    expect(script).toMatch(/-mtime \+"?'?\$RETENTION_DAYS/);
    expect(script).toContain("-print -delete");
  });

  it("fails loudly when the ssh secret is missing", () => {
    expect(script).toMatch(/missing SSH key \$BACKUP_SSH_KEY/);
    expect(script).toMatch(/missing known_hosts \$BACKUP_KNOWN_HOSTS/);
    expect(script).toMatch(/BACKUP_HOST is empty/);
  });
});

describe("chart values default to backups off with 14-day retention", () => {
  const values = read("helm/recipedb/values.yaml");
  const backup = blockAfter(values, "backup:");

  it("defaults enabled to false and retentionDays to 14", () => {
    expect(backup).toMatch(/^\s+enabled:\s*false$/m);
    expect(backup).toMatch(/^\s+retentionDays:\s*14$/m);
    expect(backup).toMatch(/^\s+sshSecretName:\s*""$/m);
    expect(backup).toMatch(/^\s+schedule:\s*"17 6 \* \* \*"$/m);
  });

  it("keeps the existing app values untouched", () => {
    expect(values).toMatch(/^replicaCount:\s*1$/m);
    expect(values).toMatch(/^strategy:\n\s+type:\s*Recreate$/m);
  });
});

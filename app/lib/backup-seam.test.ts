/**
 * Backup CronJob seam guard (roadmap item 3, "Backup CronJob (disaster
 * recovery)").
 *
 * The nightly backup cannot be reached from a unit test: it is a Helm
 * template, a Dockerfile stage and a bash script whose job is to talk to a real
 * PVC and a real ssh host. What CAN regress silently is the wiring, so these
 * assertions pin the parts that would make the job useless or dangerous:
 *
 *  - the chart gates the CronJob and the backup ssh Secret behind
 *    backup.enabled (off by default), and refuses to render an enabled job
 *    with an empty sshKey / knownHosts
 *  - ssh material flows helm values -> rendered Secret (stringData), and that
 *    Secret is mounted ONLY by the backup pod: the Deployment must not
 *    reference it, or a key rotation would restart the app
 *  - the job runs the DEPLOYMENT image (one image: the runtime stage carries
 *    ssh + rsync), not a separate <tag>-backup build
 *  - the /data claim is mounted READ-ONLY in both the volume and the mount
 *    (the app is the single writer; a backup pod must never write it)
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

/** Dockerfile instruction lines only (the surrounding prose may name tools). */
function dockerInstructions(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("helm backup CronJob", () => {
  const cronJob = read("helm/recipedb/templates/backup-cronjob.yaml");

  it("is gated on backup.enabled (opt-in, never on by default)", () => {
    expect(cronJob).toMatch(/\{\{-\s*if\s+\.Values\.backup\.enabled\s*\}\}/);
    // The whole resource is inside the guard, so `end` must be the last thing.
    expect(cronJob.trimEnd().endsWith("{{- end }}")).toBe(true);
  });

  it("fails the render when enabled without ssh key material", () => {
    // The required guards live in the Secret template the CronJob mounts.
    const secret = read("helm/recipedb/templates/backup-secret.yaml");
    expect(secret).toMatch(
      /required\s+"backup\.sshKey is required[^"]*"\s+\.Values\.backup\.sshKey/,
    );
    expect(secret).toMatch(
      /required\s+"backup\.knownHosts is required[^"]*"\s+\.Values\.backup\.knownHosts/,
    );
    // ...and the CronJob must point at exactly that Secret.
    expect(cronJob).toContain('secretName: {{ $fullname }}-backup-ssh');
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

  it("mounts the key + known_hosts from the rendered Secret group-readable (0440 + fsGroup 1000)", () => {
    expect(cronJob).toContain("defaultMode: 0440");
    expect(cronJob).toContain("BACKUP_SSH_KEY");
    expect(cronJob).toMatch(/value:\s*"\/secrets\/id_ed25519"/);
    expect(cronJob).toContain("BACKUP_KNOWN_HOSTS");
    expect(cronJob).toMatch(/value:\s*"\/secrets\/known_hosts"/);
    expect(cronJob).toMatch(/mountPath:\s*\/secrets/);
    expect(cronJob).toContain("secretName: {{ $fullname }}-backup-ssh");
    // The secret is a mount, never an env-value source: the material must not
    // end up in `kubectl describe pod` output.
    expect(cronJob).not.toContain("secretKeyRef");
  });

  it("runs the deployment image, not a separate backup tag", () => {
    expect(cronJob).toContain(
      'image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"',
    );
    expect(cronJob).toContain("imagePullPolicy: {{ .Values.image.pullPolicy }}");
    expect(cronJob).toContain("{{- with .Values.imagePullSecrets }}");
    // No leftovers from the retired backup stage / image overrides.
    expect(cronJob).not.toMatch(/-backup"|backup\.image/);
    expect(cronJob).toContain('command: ["/bin/bash", "/app/backup-k8s.sh"]');
  });

  it("passes host/path/retention through and never overlaps runs", () => {
    expect(cronJob).toContain("BACKUP_HOST");
    expect(cronJob).toContain(".Values.backup.path");
    expect(cronJob).toContain("RETENTION_DAYS");
    expect(cronJob).toContain("concurrencyPolicy: Forbid");
  });
});

describe("backup ssh Secret is rendered from values and isolated", () => {
  const secret = read("helm/recipedb/templates/backup-secret.yaml");
  const deployment = read("helm/recipedb/templates/deployment.yaml");
  const cronJob = read("helm/recipedb/templates/backup-cronjob.yaml");

  it("renders <fullname>-backup-ssh as stringData from the values file", () => {
    expect(secret).toMatch(/\{\{-\s*if\s+\.Values\.backup\.enabled\s*\}\}/);
    expect(secret).toContain("kind: Secret");
    expect(secret).toContain("-backup-ssh");
    expect(secret).toContain("stringData:");
    expect(secret).toMatch(/id_ed25519:\s*\{\{\s*required[^}]*\.Values\.backup\.sshKey/);
    expect(secret).toMatch(/known_hosts:\s*\{\{\s*required[^}]*\.Values\.backup\.knownHosts/);
    // base64 is the API server's job; the operator supplies raw PEM.
    expect(secret).not.toContain("b64enc");
    // Never part of the app Secret the Deployment checksums.
    const appSecret = read("helm/recipedb/templates/secret.yaml");
    expect(appSecret).not.toContain("backup");
  });

  it("is mounted only by the backup pod, never by the Deployment", () => {
    expect(cronJob).toContain("-backup-ssh");
    expect(deployment).not.toContain("-backup-ssh");
    expect(deployment).not.toContain("backup.sshKey");
    expect(deployment).not.toContain("/secrets");
    // The Deployment still mounts only the data volume.
    expect(deployment).toContain("- name: data");
  });
});

describe("single runtime image carries the backup tooling", () => {
  const dockerfile = read("Dockerfile");
  const instructions = dockerInstructions(dockerfile);
  const runtime = instructions.slice(
    instructions.indexOf("FROM node:26.10.0-bookworm-slim AS runtime"),
    instructions.indexOf("AS development"),
  );

  it("installs ssh + rsync into the runtime stage (no separate backup stage)", () => {
    expect(dockerfile).not.toMatch(/^FROM runtime AS backup$/m);
    expect(runtime).toContain("openssh-client");
    expect(runtime).toContain("rsync");
    expect(runtime).toMatch(/rm -rf \/var\/lib\/apt\/lists\/\*/);
    expect(runtime).toContain("deploy/backup.cjs");
    expect(runtime).toContain("deploy/backup-k8s.sh");
    expect(runtime).toContain("chmod 0755 /app/backup.cjs /app/backup-k8s.sh");
  });

  it("keeps runtime the app image and development the last stage", () => {
    expect(runtime).toContain('CMD ["node", "server.js"]');
    expect(runtime).toContain("USER node");
    expect(runtime).toContain("EXPOSE 3000");
    // No leftover backup stage between runtime and development.
    expect(instructions).not.toContain("AS backup");
    // `docker build` with no --target must still produce the dev stage, and
    // deploy.sh's `--target runtime` the app image.
    expect(instructions.trimEnd().endsWith('CMD ["npm", "run", "dev"]')).toBe(true);
    expect(dockerfile.lastIndexOf("FROM node:26.10.0-bookworm-slim AS development")).toBeGreaterThan(
      dockerfile.lastIndexOf("AS runtime"),
    );
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

  it("fails loudly when the ssh material is missing", () => {
    expect(script).toMatch(/missing SSH key \$BACKUP_SSH_KEY/);
    expect(script).toMatch(/missing known_hosts \$BACKUP_KNOWN_HOSTS/);
    expect(script).toMatch(/BACKUP_HOST is empty/);
  });
});

describe("chart values default to backups off with 14-day retention", () => {
  const values = read("helm/recipedb/values.yaml");
  const backup = blockAfter(values, "backup:");

  it("defaults enabled to false, empty ssh material, retentionDays 14", () => {
    expect(backup).toMatch(/^\s+enabled:\s*false$/m);
    expect(backup).toMatch(/^\s+retentionDays:\s*14$/m);
    expect(backup).toMatch(/^\s+sshKey:\s*""$/m);
    expect(backup).toMatch(/^\s+knownHosts:\s*""$/m);
    expect(backup).toMatch(/^\s+schedule:\s*"17 6 \* \* \*"$/m);
    // The retired operator-created-Secret / separate-image knobs are gone.
    expect(backup).not.toContain("sshSecretName");
    expect(backup).not.toContain("secretKeys");
    expect(backup).not.toMatch(/^\s+image:/m);
  });

  it("keeps the existing app values untouched", () => {
    expect(values).toMatch(/^replicaCount:\s*1$/m);
    expect(values).toMatch(/^strategy:\n\s+type:\s*Recreate$/m);
  });
});

import type { Route } from "./+types/api.backfill-training-export";
import { createGzip } from "node:zlib";
import tar from "tar-stream";
import { getDataDir, getRawSqlite } from "../db/client.server";
import { requireAuth } from "../lib/auth.server";
import {
  appendTrainingExportToTar,
  collectTrainingExport,
} from "../lib/scan/training-export.server";

export function loader() {
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}

export function action({ request }: Route.ActionArgs) {
  requireAuth(request, { isApi: true });
  if (request.method !== "POST") {
    return Response.json({ error: "method-not-allowed" }, { status: 405 });
  }

  const exportData = collectTrainingExport(getDataDir(), getRawSqlite());
  const archive = tar.pack();
  const gzip = createGzip();
  archive.on("error", (error: Error) => gzip.destroy(error));
  archive.pipe(gzip);
  appendTrainingExportToTar(archive, exportData);
  archive.finalize();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      gzip.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      gzip.on("end", () => controller.close());
      gzip.on("error", (error: Error) => controller.error(error));
    },
    cancel() {
      archive.destroy();
      gzip.destroy();
    },
  });

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return new Response(body, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="recipedb-training-export-${stamp}.tar.gz"`,
      "cache-control": "no-store",
    },
  });
}

// Resource route: keeping the module component-free preserves the action's
// binary response instead of sending it through the document pipeline.

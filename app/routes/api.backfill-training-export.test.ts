import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import tar from "tar-stream";
import { getDb, getImagesDir } from "../db/client.server";
import { ocrTrainingSamples } from "../db/schema.server";
import { executeSave } from "../lib/draft-store.server";
import { createDraft } from "../lib/import";
import { mintToken } from "../lib/tokens.server";
import { withDb } from "../lib/testing/with-db";
import { action, loader } from "./api.backfill-training-export";

withDb();

function args(request: Request) {
  return {
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: new URL(request.url).pathname,
  };
}

function request(method: string, token?: string): Request {
  return new Request("http://localhost/api/backfill/training-export", {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function expectUnauthorized(): void {
  try {
    action(args(request("POST")));
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    expect(error.status).toBe(401);
    return;
  }
  throw new Error("Expected the route to reject unauthenticated requests.");
}

function unpackTar(contents: Buffer): Promise<Map<string, Buffer>> {
  const extractor = tar.extract();
  return new Promise((resolve, reject) => {
    const files = new Map<string, Buffer>();
    extractor.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: unknown) => {
        if (!Buffer.isBuffer(chunk)) throw new Error("tar entry emitted non-buffer data");
        chunks.push(chunk);
      });
      stream.on("end", () => {
        files.set(header.name, Buffer.concat(chunks));
        next();
      });
    });
    extractor.on("finish", () => resolve(files));
    extractor.on("error", reject);
    extractor.write(contents);
    extractor.end(() => undefined);
  });
}

describe("training export route", () => {
  it("requires authentication and rejects GET with 405", async () => {
    expectUnauthorized();
    const response = loader();
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: "method-not-allowed" });
    const token = mintToken("method test").secret;
    expect(action(args(request("GET", token))).status).toBe(405);
  });

  it("cancels the archive streams when the client disconnects", async () => {
    const token = mintToken("cancel test").secret;
    const response = action(args(request("POST", token)));
    await response.body?.cancel();
  });

  it("streams an authenticated tar.gz with the accepted export layout", async () => {
    const recipeId = executeSave({
      kind: "new",
      draft: createDraft({ kind: "scan", text: "Training export" }),
    }).recipeId;
    fs.mkdirSync(path.join(getImagesDir(), String(recipeId)), { recursive: true });
    fs.writeFileSync(
      path.join(getImagesDir(), String(recipeId), "page-1.png"),
      "page image bytes",
    );
    getDb()
      .insert(ocrTrainingSamples)
      .values([
        {
          recipeId,
          pageNo: 1,
          imageFilename: `${recipeId}/page-1.png`,
          rawOcrText: "recognized",
          correctedText: "Corrected OCR\n",
          acceptedAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          recipeId,
          pageNo: 2,
          imageFilename: `${recipeId}/page-2.png`,
          rawOcrText: "unreviewed",
          correctedText: "unreviewed",
          acceptedAt: null,
        },
      ])
      .run();
    const token = mintToken("training export test").secret;

    const response = action(args(request("POST", token)));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="recipedb-training-export-\d{8}T\d{6}Z\.tar\.gz"$/,
    );
    const compressed = Buffer.from(await response.arrayBuffer());
    const files = await unpackTar(gunzipSync(compressed));
    expect([...files.keys()]).toEqual([
      "images/",
      "ground-truth/",
      `images/${recipeId}_page1.png`,
      `ground-truth/${recipeId}_page1.gt.txt`,
      "filelist.txt",
      "README.md",
    ]);
    expect(files.get(`images/${recipeId}_page1.png`)?.toString()).toBe(
      "page image bytes",
    );
    expect(files.get(`ground-truth/${recipeId}_page1.gt.txt`)?.toString()).toBe(
      "Corrected OCR\n",
    );
    expect(files.get("filelist.txt")?.toString()).toBe(`${recipeId}_page1\n`);
    expect(files.get("README.md")?.toString()).toContain(
      "1 unreviewed row(s) across 1 recipe(s)",
    );
  });
});

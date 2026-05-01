/**
 * Vercel Blob adapter. Used by ingestion (write) and read paths
 * (re-fetch) for filing HTML + submissions JSON. Falls back to local
 * disk in fixture mode so dev doesn't need a Blob token.
 */
import { put, head, del } from "@vercel/blob";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCAL_ROOT = join(process.cwd(), ".fixtures", "blob-local");

function localPath(key: string): string {
  return join(LOCAL_ROOT, key);
}

function hasToken(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function putArtifact(
  key: string,
  body: string | Buffer,
  contentType = "text/html",
): Promise<{ url: string; key: string }> {
  if (!hasToken()) {
    const target = localPath(key);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    return { url: `file://${target}`, key };
  }
  const blob = await put(key, body, {
    access: "public",
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return { url: blob.url, key };
}

export async function getArtifactBytes(key: string): Promise<Buffer | null> {
  if (!hasToken()) {
    const path = localPath(key);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }
  const meta = await head(key);
  const res = await fetch(meta.url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteArtifact(key: string): Promise<void> {
  if (!hasToken()) return;
  await del(key);
}

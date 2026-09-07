/**
 * SHA-256 of a File's bytes, hex-encoded. Runs entirely on the caller
 * (browser via Web Crypto, or Node — `crypto.subtle` is a global in
 * both since Node 20), so the presign-upload endpoint can dedup on
 * content hash without ever needing to read the file's bytes itself.
 */
export async function sha256Hex(file: File | Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

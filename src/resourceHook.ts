// Best-effort artifact registration for Maestro (github.com/faces-sh).
//
// When this server runs inside Maestro, the app injects a loopback broker URL + secret via env
// (MAESTRO_ARTIFACT_URL / MAESTRO_ARTIFACT_SECRET). After a tool creates or edits an artifact (a Doc, a
// Sheet, a Slides deck, a Drive file), it calls registerArtifact() with the structured result it already
// has, and we POST an envelope to that broker so Maestro can file it as a workspace resource.
//
// This is deliberately fire-and-forget: it NEVER throws, NEVER blocks the tool's own result, and is a
// no-op when the env is absent (i.e. when the server runs outside Maestro, e.g. under plain npx). The
// model never sees any of this; registration happens out of band.

export interface ArtifactEnvelope {
  provider: string;      // "google_docs"
  provider_ref: string;  // the provider's stable id (a Drive file id)
  kind: string;          // "doc" | "sheet" | "slides" | "file"
  title: string;
  uri: string;           // display + open link (webViewLink)
  summary?: string;
  tags?: string[];
}

export function registerArtifact(envelope: ArtifactEnvelope): void {
  const url = process.env.MAESTRO_ARTIFACT_URL;
  const secret = process.env.MAESTRO_ARTIFACT_SECRET;
  if (!url || !secret) return; // not running under Maestro: nothing to file
  if (!envelope.provider_ref || !envelope.uri) return; // nothing addressable to register

  // Fire-and-forget. Swallow every error (network, broker down, malformed) so a doc is never blocked by a
  // registration failure. A short timeout keeps a hung broker from lingering.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Artifact-Secret": secret },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  } catch {
    // ignore
  }
}

import path from "node:path";

// Validate the exact, case-sensitive paths that Chrome will load from the ZIP.
// This is a static packaging check, not a substitute for a Chrome smoke test.
export function validateExtension(entries) {
  const files = new Map(entries.map(({ name, data }) => [name, data]));
  const requireFile = (reference, from = "manifest.json") => {
    if (
      typeof reference !== "string" ||
      !reference ||
      /[\\\\?#]/.test(reference) ||
      /^(?:[a-z]+:|\/)/i.test(reference)
    )
      throw new Error(
        `Invalid local resource ${JSON.stringify(reference)} in ${from}`,
      );
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(from), reference),
    );
    if (
      resolved.startsWith("../") ||
      !files.has(resolved) ||
      !files.get(resolved).length
    )
      throw new Error(
        `Missing or empty extension resource: ${resolved} (referenced by ${from})`,
      );
    return resolved;
  };
  requireFile("manifest.json");
  const manifest = JSON.parse(files.get("manifest.json").toString());
  if (manifest.manifest_version !== 3)
    throw new Error("Only Manifest V3 is supported");
  requireFile(manifest.action?.default_popup);
  requireFile(manifest.background?.service_worker);
  for (const icons of [manifest.icons, manifest.action?.default_icon])
    for (const icon of Object.values(icons || {})) requireFile(icon);
  for (const [name, data] of files) {
    const source = data.toString();
    if (/\.html$/.test(name)) {
      for (const match of source.matchAll(
        /\b(?:src|href)\s*=\s*["']([^"']+)["']/g,
      ))
        requireFile(match[1], name);
    } else if (/\.(?:mjs|js)$/.test(name)) {
      for (const match of source.matchAll(
        /\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?["']([^"']+)["']/g,
      ))
        requireFile(match[1], name);
      for (const match of source.matchAll(
        /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
      ))
        requireFile(match[1], name);
    } else if (/\.css$/.test(name)) {
      for (const match of source.matchAll(
        /url\(\s*["']?([^"')\s]+)["']?\s*\)/g,
      ))
        requireFile(match[1], name);
    }
  }
  return manifest;
}

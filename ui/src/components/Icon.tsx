import type { Entry } from "../lib/api";

// Colour families by extension; no icon font, no network, crisp at any DPI.
const FAMILY: Record<string, string> = {};
const add = (fam: string, exts: string) => exts.split(" ").forEach((e) => (FAMILY[e] = fam));
add("img", "png jpg jpeg gif webp bmp svg ico tif tiff heic avif raw cr2 nef");
add("vid", "mp4 mkv mov avi webm wmv m4v flv");
add("aud", "mp3 wav flac ogg m4a aac wma opus aiff");
add("doc", "pdf doc docx odt rtf txt md markdown");
add("sheet", "xls xlsx csv tsv ods parquet");
add("code", "rs ts tsx js jsx py go c h cpp hpp cs java kt swift rb php lua sh ps1 bat cmd json toml yaml yml xml html css scss sql");
add("arch", "zip 7z rar tar gz bz2 xz zst iso");
add("exe", "exe msi dll sys appx msix");

export function Icon(p: { entry: Entry }) {
  const fam = () => (p.entry.kind === "dir" ? "dir" : p.entry.kind === "symlink" ? "link" : FAMILY[p.entry.ext] ?? "file");
  return (
    <span class={`ico ico-${fam()}`} aria-hidden="true">
      {fam() === "dir" ? (
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" fill="currentColor" />
        </svg>
      ) : fam() === "link" ? (
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path d="M6 10l4-4M5 7L3.5 8.5a2.1 2.1 0 003 3L8 10M11 9l1.5-1.5a2.1 2.1 0 00-3-3L8 6" stroke="currentColor" stroke-width="1.5" fill="none" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path d="M3.5 1.5h6l3 3v10h-9z" fill="currentColor" opacity=".9" />
          <path d="M9.5 1.5v3h3" fill="none" stroke="var(--bg)" stroke-width="1" />
        </svg>
      )}
    </span>
  );
}

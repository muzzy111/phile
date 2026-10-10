//! File inspection: checksums, MIME type, hex dump, bounded text reads.

use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum MetaError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
pub type Result<T> = std::result::Result<T, MetaError>;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hashes {
    pub sha256: String,
    pub md5: String,
    pub blake3: String,
}

/// All three digests in one streaming pass.
pub fn hash_file(path: &Path) -> Result<Hashes> {
    let mut f = File::open(path)?;
    let mut s = sha2::Sha256::new();
    let mut m = md5::Md5::new();
    let mut b = blake3::Hasher::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        s.update(&buf[..n]);
        m.update(&buf[..n]);
        b.update(&buf[..n]);
    }
    Ok(Hashes { sha256: hex::encode(s.finalize()), md5: hex::encode(m.finalize()), blake3: b.finalize().to_hex().to_string() })
}

/// Fast blake3 only; used for transfer verification.
pub fn blake3_file(path: &Path) -> Result<String> {
    let mut h = blake3::Hasher::new();
    let mut f = File::open(path)?;
    std::io::copy(&mut f, &mut h)?;
    Ok(h.finalize().to_hex().to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sniff {
    pub mime: String,
    pub is_text: bool,
    pub encoding: String,
}

/// Magic-byte sniff with extension fallback and a text heuristic.
pub fn sniff(path: &Path) -> Result<Sniff> {
    let mut f = File::open(path)?;
    let mut buf = vec![0u8; 8192];
    let n = f.read(&mut buf)?;
    buf.truncate(n);
    if let Some(k) = infer::get(&buf) {
        return Ok(Sniff { mime: k.mime_type().into(), is_text: false, encoding: "binary".into() });
    }
    let (is_text, encoding) = text_kind(&buf);
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mime = mime_from_ext(&ext).unwrap_or(if is_text { "text/plain" } else { "application/octet-stream" });
    Ok(Sniff { mime: mime.into(), is_text, encoding: encoding.into() })
}

fn text_kind(b: &[u8]) -> (bool, &'static str) {
    if b.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (true, "utf-8-bom");
    }
    if b.starts_with(&[0xFF, 0xFE]) {
        return (true, "utf-16le");
    }
    if b.starts_with(&[0xFE, 0xFF]) {
        return (true, "utf-16be");
    }
    if b.contains(&0) {
        return (false, "binary");
    }
    // Allow a truncated multi-byte char at the end of the sample.
    match std::str::from_utf8(b) {
        Ok(_) => (true, if b.is_ascii() { "ascii" } else { "utf-8" }),
        Err(e) if e.valid_up_to() + 4 >= b.len() => (true, "utf-8"),
        Err(_) => (true, "windows-1252"),
    }
}

pub fn mime_from_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "md" | "markdown" => "text/markdown",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" => "application/json",
        "toml" => "application/toml",
        "yaml" | "yml" => "application/yaml",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "rs" => "text/x-rust",
        "py" => "text/x-python",
        "ps1" => "text/x-powershell",
        "parquet" => "application/vnd.apache.parquet",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Classic 16-bytes-per-row hex dump of `len` bytes from `offset`.
pub fn hex_dump(path: &Path, offset: u64, len: usize) -> Result<String> {
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len];
    let n = f.read(&mut buf)?;
    buf.truncate(n);
    let mut out = String::with_capacity(n * 4);
    for (i, row) in buf.chunks(16).enumerate() {
        out.push_str(&format!("{:08x}  ", offset as usize + i * 16));
        for j in 0..16 {
            match row.get(j) {
                Some(b) => out.push_str(&format!("{b:02x} ")),
                None => out.push_str("   "),
            }
            if j == 7 {
                out.push(' ');
            }
        }
        out.push(' ');
        out.extend(row.iter().map(|&b| if (0x20..0x7f).contains(&b) { b as char } else { '.' }));
        out.push('\n');
    }
    Ok(out)
}

/// Read up to `max` bytes as lossy UTF-8 for previews. Returns (text, truncated).
pub fn read_text(path: &Path, max: usize) -> Result<(String, bool)> {
    let f = File::open(path)?;
    let total = f.metadata()?.len() as usize;
    let mut buf = Vec::with_capacity(max.min(total));
    f.take(max as u64).read_to_end(&mut buf)?;
    let s = if buf.starts_with(&[0xEF, 0xBB, 0xBF]) { &buf[3..] } else { &buf[..] };
    Ok((String::from_utf8_lossy(s).into_owned(), total > max))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_known_value() {
        let t = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(t.path(), b"abc").unwrap();
        let h = hash_file(t.path()).unwrap();
        assert_eq!(h.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(h.md5, "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn hex_and_sniff() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.md");
        std::fs::write(&p, b"# Hi\n").unwrap();
        assert!(hex_dump(&p, 0, 64).unwrap().starts_with("00000000  23 20 48"));
        let s = sniff(&p).unwrap();
        assert_eq!(s.mime, "text/markdown");
        assert!(s.is_text);
    }
}

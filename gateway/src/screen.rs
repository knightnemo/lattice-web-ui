//! The host's hidden display, for the owner.
//!
//! Lattice opens some things as native windows: the folder picker, save
//! dialogs, Overleaf sign-in. On a headless host they land on the private
//! Xvfb display, where nobody can see them. Xvfb mirrors its screen into a
//! file (`-fbdir`, XWD format). The gateway turns that file into a PNG on
//! request, and hands clicks and keys back to the display through xdotool.

use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

pub struct Screen {
    pub framebuffer: PathBuf,
    pub xdotool: PathBuf,
    pub display: String,
    pub library_path: Option<PathBuf>,
}

/// An XWD ZPixmap with 32 bits per pixel, as Xvfb writes it at depth 24.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

pub fn parse_xwd(bytes: &[u8]) -> Result<Frame, String> {
    let field = |index: usize| be32(bytes, index * 4).ok_or("The display file is truncated.");
    let header_size = field(0)? as usize;
    let (format, depth, width, height) = (field(2)?, field(3)?, field(4)?, field(5)?);
    let byte_order = field(7)?;
    let bits_per_pixel = field(11)?;
    let bytes_per_line = field(12)? as usize;
    let colors = field(19)? as usize;
    if format != 2
        || bits_per_pixel != 32
        || depth != 24
        || width == 0
        || height == 0
        || width > 8192
        || height > 8192
    {
        return Err(format!(
            "Unsupported display format (format {format}, depth {depth}, {bits_per_pixel} bpp)."
        ));
    }
    let start = header_size + colors * 12;
    let end = start + bytes_per_line * height as usize;
    let data = bytes
        .get(start..end)
        .ok_or("The display file is truncated.")?;
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for row in data.chunks_exact(bytes_per_line) {
        for pixel in row[..width as usize * 4].as_chunks::<4>().0 {
            // LSBFirst stores B, G, R, X; MSBFirst stores X, R, G, B.
            if byte_order == 0 {
                rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
            } else {
                rgb.extend_from_slice(&[pixel[1], pixel[2], pixel[3]]);
            }
        }
    }
    Ok(Frame { width, height, rgb })
}

/// The part of the screen that has windows on it (Xvfb runs with a black
/// root), with a small margin, as (x, y, width, height). None when empty.
pub fn content_box(frame: &Frame) -> Option<(u32, u32, u32, u32)> {
    let (w, h) = (frame.width as usize, frame.height as usize);
    let (mut left, mut top, mut right, mut bottom) = (w, h, 0usize, 0usize);
    for y in 0..h {
        let row = &frame.rgb[y * w * 3..(y + 1) * w * 3];
        if let Some(first) = row.as_chunks::<3>().0.iter().position(|p| p != &[0, 0, 0]) {
            let last = row
                .as_chunks::<3>()
                .0
                .iter()
                .rposition(|p| p != &[0, 0, 0])
                .unwrap_or(first);
            left = left.min(first);
            right = right.max(last + 1);
            top = top.min(y);
            bottom = y + 1;
        }
    }
    if right == 0 {
        return None;
    }
    let margin = 8;
    let (x0, y0) = (left.saturating_sub(margin), top.saturating_sub(margin));
    let (x1, y1) = ((right + margin).min(w), (bottom + margin).min(h));
    Some((x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32))
}

pub fn crop(frame: &Frame, (x, y, width, height): (u32, u32, u32, u32)) -> Frame {
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for row in y..y + height {
        let start = (row as usize * frame.width as usize + x as usize) * 3;
        rgb.extend_from_slice(&frame.rgb[start..start + width as usize * 3]);
    }
    Frame { width, height, rgb }
}

/// A plain RGB PNG: zlib-compressed scanlines with filter 0.
pub fn encode_png(frame: &Frame) -> Vec<u8> {
    let mut raw = Vec::with_capacity(frame.rgb.len() + frame.height as usize);
    for row in frame.rgb.chunks_exact(frame.width as usize * 3) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&raw).expect("writing to memory");
    let compressed = encoder.finish().expect("writing to memory");

    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut chunk = |kind: &[u8; 4], data: &[u8]| {
        png.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut crc = crc32fast::Hasher::new();
        crc.update(kind);
        crc.update(data);
        png.extend_from_slice(kind);
        png.extend_from_slice(data);
        png.extend_from_slice(&crc.finalize().to_be_bytes());
    };
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&frame.width.to_be_bytes());
    header.extend_from_slice(&frame.height.to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(b"IHDR", &header);
    chunk(b"IDAT", &compressed);
    chunk(b"IEND", &[]);
    png
}

/// Keys the page may send by name. Anything else is typed as text.
pub const NAMED_KEYS: &[&str] = &[
    "Return",
    "Tab",
    "Escape",
    "BackSpace",
    "Delete",
    "Up",
    "Down",
    "Left",
    "Right",
    "ctrl+a",
    "ctrl+v",
    "ctrl+l",
];

pub enum Input {
    Click { x: u32, y: u32 },
    Key(String),
    Text(String),
}

impl Screen {
    /// The windows on the screen as a PNG, and where that crop sits on the screen.
    pub fn png(&self) -> Result<(Vec<u8>, (u32, u32)), String> {
        let bytes = std::fs::read(&self.framebuffer)
            .map_err(|e| format!("The host display is not available: {e}"))?;
        let frame = parse_xwd(&bytes)?;
        Ok(match content_box(&frame) {
            Some(area) => (encode_png(&crop(&frame, area)), (area.0, area.1)),
            None => {
                let empty = (0, 0, frame.width.min(480), frame.height.min(270));
                (encode_png(&crop(&frame, empty)), (0, 0))
            }
        })
    }

    fn xdotool(&self) -> Command {
        let mut command = Command::new(&self.xdotool);
        command.env_clear().env("DISPLAY", &self.display);
        if let Some(path) = &self.library_path {
            command.env("LD_LIBRARY_PATH", path);
        }
        command
    }

    /// Without a window manager, keys go to whatever has the input focus.
    /// Give it to the newest visible window with a title, which is the dialog in
    /// front (untitled helper windows are skipped).
    fn focus_front_window(&self) {
        let Ok(output) = self
            .xdotool()
            .args(["search", "--onlyvisible", "--name", ".+"])
            .output()
        else {
            return;
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut ids = stdout
            .lines()
            .filter(|line| !line.is_empty() && line.bytes().all(|b| b.is_ascii_digit()));
        if let Some(id) = ids.next_back() {
            let _ = self.xdotool().args(["windowfocus", "--sync", id]).status();
        }
    }

    /// Whether a window is drawn: Xvfb runs with a black root (`-br`), and
    /// anything smaller than 40x40 (the pointer, 1x1 helpers) does not count.
    pub fn has_windows(&self) -> Result<bool, String> {
        let bytes = std::fs::read(&self.framebuffer)
            .map_err(|e| format!("The host display is not available: {e}"))?;
        Ok(content_box(&parse_xwd(&bytes)?)
            .is_some_and(|(_, _, w, h)| w >= 40 + 16 && h >= 40 + 16))
    }

    pub fn send(&self, input: &Input) -> Result<(), String> {
        if !matches!(input, Input::Click { .. }) {
            self.focus_front_window();
        }
        let mut command = self.xdotool();
        match input {
            Input::Click { x, y } => command.args([
                "mousemove",
                "--sync",
                &x.to_string(),
                &y.to_string(),
                "click",
                "1",
            ]),
            Input::Key(key) if NAMED_KEYS.contains(&key.as_str()) => {
                command.args(["key", "--clearmodifiers", key])
            }
            Input::Key(_) => return Err("That key is not supported.".into()),
            Input::Text(text)
                if text.chars().count() <= 512 && !text.chars().any(|c| c.is_control()) =>
            {
                command.args(["type", "--delay", "8", "--", text])
            }
            Input::Text(_) => {
                return Err("Send at most 512 characters without control characters.".into())
            }
        };
        let status = command
            .status()
            .map_err(|e| format!("Could not run xdotool: {e}"))?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "xdotool could not deliver the input.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xwd(width: u32, height: u32, pixels: &[[u8; 4]]) -> Vec<u8> {
        let header_size = 100u32 + 8; // 25 fields plus a short window name
        let mut fields = [0u32; 25];
        fields[0] = header_size;
        fields[1] = 7;
        fields[2] = 2;
        fields[3] = 24;
        fields[4] = width;
        fields[5] = height;
        fields[7] = 0;
        fields[11] = 32;
        fields[12] = width * 4;
        fields[19] = 0;
        let mut out: Vec<u8> = fields.iter().flat_map(|f| f.to_be_bytes()).collect();
        out.extend_from_slice(b"Xvfb\0\0\0\0");
        for pixel in pixels {
            out.extend_from_slice(pixel);
        }
        out
    }

    #[test]
    fn reads_xvfb_framebuffer_and_writes_a_png() {
        let frame = parse_xwd(&xwd(2, 1, &[[0x10, 0x20, 0x30, 0], [0xff, 0, 0, 0]])).unwrap();
        assert_eq!((frame.width, frame.height), (2, 1));
        assert_eq!(frame.rgb, vec![0x30, 0x20, 0x10, 0, 0, 0xff]);
        let png = encode_png(&frame);
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(&png[12..16], b"IHDR");
        assert!(
            png.ends_with(&[0xae, 0x42, 0x60, 0x82]),
            "the IEND chunk has its fixed CRC"
        );
    }

    #[test]
    fn crops_to_the_windows_on_a_black_screen() {
        let mut rgb = vec![0u8; 40 * 30 * 3];
        for y in 10..15 {
            for x in 20..25 {
                rgb[(y * 40 + x) * 3] = 200;
            }
        }
        let frame = Frame {
            width: 40,
            height: 30,
            rgb,
        };
        assert_eq!(content_box(&frame), Some((12, 2, 21, 21)));
        let cropped = crop(&frame, (12, 2, 21, 21));
        assert_eq!(
            (cropped.width, cropped.height, cropped.rgb.len()),
            (21, 21, 21 * 21 * 3)
        );
        assert_eq!(
            content_box(&Frame {
                width: 4,
                height: 4,
                rgb: vec![0; 48]
            }),
            None
        );
    }

    #[test]
    fn rejects_truncated_or_unexpected_files() {
        assert!(parse_xwd(&[0; 10]).is_err());
        let mut bytes = xwd(2, 1, &[[0; 4], [0; 4]]);
        bytes.truncate(bytes.len() - 1);
        assert!(parse_xwd(&bytes).is_err());
    }
}

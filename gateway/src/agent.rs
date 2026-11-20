//! Lattice's Agent from another device.
//!
//! Lattice runs its Agent UI (Synara) on its own loopback port and shows it in
//! an iframe at `http://127.0.0.1:<port>`. The gateway serves that port on a
//! second public origin, so the iframe keeps an origin of its own, as it has
//! on the desktop. The workspace page tells the gateway which port Synara
//! uses; the gateway only accepts a port that a process of the installed
//! Lattice listens on, so the second origin cannot reach any other service.

use std::fs;
use std::path::Path;

/// Loopback TCP ports in LISTEN state, with their socket inodes (IPv4 and IPv6).
fn listening_inodes(port: u16) -> Vec<u64> {
    let mut inodes = Vec::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = fs::read_to_string(table) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 10 || fields[3] != "0A" {
                continue;
            }
            let Some((address, port_hex)) = fields[1].rsplit_once(':') else {
                continue;
            };
            let loopback = address == "0100007F" || address == "00000000000000000000000001000000";
            if loopback && u16::from_str_radix(port_hex, 16).ok() == Some(port) {
                if let Ok(inode) = fields[9].parse() {
                    inodes.push(inode);
                }
            }
        }
    }
    inodes
}

/// True when a process whose executable or command line lies under `marker`
/// (the host's Lattice releases) listens on loopback `port`.
pub fn port_belongs_to_lattice(port: u16, marker: &Path) -> bool {
    let inodes = listening_inodes(port);
    if inodes.is_empty() {
        return false;
    }
    let wanted: Vec<String> = inodes
        .iter()
        .map(|inode| format!("socket:[{inode}]"))
        .collect();
    let marker = marker.to_string_lossy();
    let Ok(processes) = fs::read_dir("/proc") else {
        return false;
    };
    for process in processes.filter_map(Result::ok) {
        let pid = process.path();
        let Ok(fds) = fs::read_dir(pid.join("fd")) else {
            continue;
        };
        let owns = fds.filter_map(Result::ok).any(|fd| {
            fs::read_link(fd.path())
                .is_ok_and(|target| wanted.iter().any(|w| target.as_os_str() == w.as_str()))
        });
        if !owns {
            continue;
        }
        let exe = fs::read_link(pid.join("exe"))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let cmdline = fs::read(pid.join("cmdline"))
            .map(|b| String::from_utf8_lossy(&b).replace('\0', " "))
            .unwrap_or_default();
        return exe.contains(marker.as_ref()) || cmdline.contains(marker.as_ref());
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn only_a_process_under_the_marker_counts() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!listening_inodes(port).is_empty());
        // This test process runs from target/, not from a Lattice release.
        assert!(!port_belongs_to_lattice(
            port,
            Path::new("/nonexistent/lattice-host/releases")
        ));
        let own = std::env::current_exe().unwrap();
        assert!(port_belongs_to_lattice(port, own.parent().unwrap()));
        drop(listener);
        assert!(
            !port_belongs_to_lattice(port, own.parent().unwrap()),
            "a closed port belongs to nobody"
        );
    }
}

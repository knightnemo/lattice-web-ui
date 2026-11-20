//! A shell on the host for the owner.
//!
//! Lattice keeps its own terminal to its native window, by design. The
//! gateway offers the owner a separate one: a login shell on a PTY, spoken to
//! over a WebSocket. Output travels as binary frames; input and window size
//! arrive as JSON text frames. The shell's process group is hung up when the
//! socket closes.

use futures_util::{SinkExt, StreamExt};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

pub struct Terminal {
    pub shell: PathBuf,
    pub cwd: PathBuf,
}

struct Pty {
    master: OwnedFd,
    child: std::process::Child,
}

fn set_size(fd: i32, cols: u16, rows: u16) {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: TIOCSWINSZ reads a winsize from a valid pointer on a PTY fd.
    unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &size) };
}

fn spawn(terminal: &Terminal) -> std::io::Result<Pty> {
    let (mut master, mut slave) = (0, 0);
    // SAFETY: openpty writes two new fds into the provided integers.
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: both fds were just returned by openpty and are owned here.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    set_size(master.as_raw_fd(), 100, 30);
    let mut command = Command::new(&terminal.shell);
    command
        .arg("-l")
        .current_dir(&terminal.cwd)
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    Ok(Pty { master, child })
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

/// Run one shell for one WebSocket until either side ends.
pub async fn serve<S>(terminal: &Terminal, socket: WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut sink, mut stream) = socket.split();
    let mut pty = match spawn(terminal) {
        Ok(pty) => pty,
        Err(error) => {
            let _ = sink
                .send(Message::text(format!(
                    "\r\nCould not start {}: {error}\r\n",
                    terminal.shell.display()
                )))
                .await;
            return;
        }
    };
    let master_fd = pty.master.as_raw_fd();
    let mut reader = File::from(pty.master.try_clone().expect("dup the PTY"));
    let mut writer = File::from(pty.master.try_clone().expect("dup the PTY"));
    let (output_tx, mut output_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 || output_tx.blocking_send(buffer[..read].to_vec()).is_err() {
                break;
            }
        }
    });
    let (input_tx, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(bytes) = input_rx.recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
        }
    });
    loop {
        tokio::select! {
            output = output_rx.recv() => match output {
                Some(bytes) => if sink.send(Message::binary(bytes)).await.is_err() { break },
                None => break, // the shell exited
            },
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(ClientMessage::Input { data }) => { let _ = input_tx.send(data.into_bytes()); }
                    Ok(ClientMessage::Resize { cols, rows }) if (2..=1000).contains(&cols) && (2..=1000).contains(&rows) => set_size(master_fd, cols, rows),
                    _ => {}
                },
                Some(Ok(Message::Binary(bytes))) => { let _ = input_tx.send(bytes.to_vec()); }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    // SAFETY: signalling the shell's own process group, which setsid created.
    unsafe { libc::kill(-(pty.child.id() as i32), libc::SIGHUP) };
    let _ = sink.close().await;
    let _ = tokio::task::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let _ = pty.child.kill();
        let _ = pty.child.wait();
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_runs_on_a_pty_with_its_own_session() {
        let terminal = Terminal {
            shell: "/bin/sh".into(),
            cwd: std::env::temp_dir(),
        };
        let mut pty = spawn(&terminal).unwrap();
        let mut io = File::from(pty.master.try_clone().unwrap());
        io.write_all(b"tty; echo PG$(ps -o pgid= $$ | tr -d ' ')=$$; exit\n")
            .unwrap();
        let mut output = String::new();
        let mut buffer = [0u8; 4096];
        // The PTY reports EIO once the shell has exited and the slave is closed.
        while let Ok(read) = io.read(&mut buffer) {
            if read == 0 {
                break;
            }
            output.push_str(&String::from_utf8_lossy(&buffer[..read]));
        }
        let _ = pty.child.wait();
        assert!(output.contains("/dev/pts/"), "{output}");
        let pid = pty.child.id();
        assert!(
            output.contains(&format!("PG{pid}={pid}")),
            "the shell leads its own process group: {output}"
        );
    }
}

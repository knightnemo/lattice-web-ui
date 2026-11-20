//! TeX packages for the owner, while Lattice has no one-click install on Linux.
//!
//! When a build stops at a missing `lipsum.sty`, the owner can name that file
//! (or the package) on the gateway's TeX page. The gateway resolves the file to
//! its TeX Live package with `tlmgr search --global --file` and installs it
//! with `tlmgr install`, as the host user, into a TeX installation that user
//! can write to (TinyTeX or a user-mode tree). An outdated tlmgr is updated
//! first (`tlmgr update --self`), as the macOS one-click install does.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

pub enum TexError {
    /// Several packages provide the file: the caller picks one.
    Choose(Vec<String>),
    Failed(String),
}

impl From<String> for TexError {
    fn from(message: String) -> Self {
        TexError::Failed(message)
    }
}

pub struct Tex {
    pub tlmgr: PathBuf,
    /// Run `tlmgr install --dry-run`: for tests, which must not change TeX.
    pub dry_run: bool,
}

/// A package name or a file name such as `lipsum.sty`: letters, digits, `-`, `_`, `.`.
pub fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        && !name.starts_with(['.', '-'])
}

fn is_file_name(name: &str) -> bool {
    [
        ".sty", ".cls", ".bst", ".bbx", ".cbx", ".def", ".fd", ".tex", ".ldf", ".cfg", ".clo",
    ]
    .iter()
    .any(|ext| name.ends_with(ext))
}

/// The packages `tlmgr search --global --file` lists for a file (lines ending in ':').
pub fn packages_from_search(output: &str, file: &str) -> Vec<String> {
    let mut packages = Vec::new();
    let mut current: Option<String> = None;
    for line in output.lines() {
        if !line.starts_with(char::is_whitespace)
            && line.ends_with(':')
            && !line.starts_with("tlmgr")
        {
            current = Some(line.trim_end_matches(':').to_string());
        } else if let Some(package) = &current {
            if line.trim().rsplit('/').next() == Some(file) && !packages.contains(package) {
                packages.push(package.clone());
            }
        }
    }
    packages
}

async fn run(tlmgr: &PathBuf, args: &[&str]) -> Result<String, String> {
    let child = Command::new(tlmgr)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(Duration::from_secs(300), child)
        .await
        .map_err(|_| "tlmgr did not finish within five minutes.".to_string())?
        .map_err(|e| format!("Could not run tlmgr: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        Ok(text)
    } else {
        Err(text
            .lines()
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n"))
    }
}

impl Tex {
    /// Install the package that provides `name`. Returns the package and tlmgr's last lines.
    pub async fn install(&self, name: &str) -> Result<(String, String), TexError> {
        if !valid_name(name) {
            return Err(TexError::Failed(
                "Name one package or one file, such as lipsum or lipsum.sty.".into(),
            ));
        }
        let package = if is_file_name(name) {
            let found = run(
                &self.tlmgr,
                &["search", "--global", "--file", &format!("/{name}")],
            )
            .await?;
            let packages = packages_from_search(&found, name);
            match packages.as_slice() {
                [one] => one.clone(),
                [] => {
                    return Err(TexError::Failed(format!(
                        "No TeX Live package provides {name}."
                    )))
                }
                many => return Err(TexError::Choose(many.to_vec())),
            }
        } else {
            name.to_string()
        };
        let mut args = vec!["install"];
        if self.dry_run {
            args.push("--dry-run");
        }
        args.push(&package);
        let output = match run(&self.tlmgr, &args).await {
            // An outdated tlmgr refuses every install until it updates itself.
            Err(message)
                if message.contains("tlmgr itself needs to be updated") && !self.dry_run =>
            {
                run(&self.tlmgr, &["update", "--self"]).await?;
                run(&self.tlmgr, &args).await?
            }
            other => other?,
        };
        let tail = output
            .lines()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        Ok((package, tail))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_one_plain_word() {
        assert!(valid_name("lipsum"));
        assert!(valid_name("lipsum.sty"));
        assert!(valid_name("pgf-blur"));
        for bad in [
            "",
            "-x",
            ".sty",
            "a b",
            "a;rm",
            "../x",
            "a/b",
            &"x".repeat(65),
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn reads_the_packages_tlmgr_lists_for_a_file() {
        let output = "tlmgr: package repository https://mirror (verified)\nlipsum:\n\ttexmf-dist/tex/latex/lipsum/lipsum.sty\nother:\n\ttexmf-dist/tex/latex/other/notlipsum.sty\n";
        assert_eq!(
            packages_from_search(output, "lipsum.sty"),
            vec!["lipsum".to_string()]
        );
        assert!(packages_from_search(output, "missing.sty").is_empty());
    }
}

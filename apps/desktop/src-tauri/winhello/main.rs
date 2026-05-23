// Windows Hello biometric sidecar for Graphnosis.
//
// Mirrors the Swift graphnosis-biometric sidecar protocol:
//   --check           exit 0 if Windows Hello is available and configured,
//                     exit 1 otherwise.
//   --prompt <reason> prompt the user with Windows Hello; exit 0 on success,
//                     exit 1 if unavailable, exit 2 if the user cancelled or
//                     biometric mismatch.
//
// Compiled by build.rs on Windows targets into:
//   binaries/graphnosis-biometric-x86_64-pc-windows-msvc.exe

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--check") => check(),
        Some("--prompt") => {
            let reason = args.get(2).map(String::as_str).unwrap_or(
                "Unlock your Graphnosis Cortex",
            );
            prompt(reason);
        }
        _ => {
            eprintln!("usage: graphnosis-biometric --check | --prompt <reason>");
            std::process::exit(1);
        }
    }
}

#[cfg(target_os = "windows")]
fn check() {
    use windows::Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability};
    let result = windows::core::block_on(UserConsentVerifier::CheckAvailabilityAsync().unwrap());
    match result {
        Ok(UserConsentVerifierAvailability::Available) => std::process::exit(0),
        _ => std::process::exit(1),
    }
}

#[cfg(target_os = "windows")]
fn prompt(reason: &str) {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{UserConsentVerifier, UserConsentVerificationResult};
    let result = windows::core::block_on(
        UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(reason)).unwrap(),
    );
    match result {
        Ok(UserConsentVerificationResult::Verified) => std::process::exit(0),
        Ok(_) => std::process::exit(2),
        Err(e) => {
            eprintln!("Windows Hello error: {}", e.message());
            std::process::exit(1);
        }
    }
}

// Stub implementations for non-Windows builds so the file compiles in CI
// environments that aren't Windows. The build.rs only invokes this binary
// on Windows targets, so these stubs are never actually called at runtime.
#[cfg(not(target_os = "windows"))]
fn check() { std::process::exit(1); }

#[cfg(not(target_os = "windows"))]
fn prompt(_reason: &str) { std::process::exit(1); }

fn main() {
    // ── Swift biometric sidecar (macOS only) ───────────────────────────────
    //
    // Compile swift/graphnosis-biometric.swift into a binary that the Tauri
    // shell can spawn for Touch ID / biometric prompts. Output path follows
    // Tauri's externalBin convention so the same binary works in dev and
    // bundled-release: `binaries/graphnosis-biometric-<rust-triple>`.
    //
    // IMPORTANT: this MUST run BEFORE `tauri_build::build()` because Tauri's
    // build step validates that every `externalBin` resource declared in
    // `tauri.conf.json` exists on disk; if the Swift binary is missing it
    // errors with "resource path ... doesn't exist" and the whole cargo
    // build fails.
    //
    // Build failures inside `build_swift_biometric` itself are NON-fatal —
    // they produce a cargo:warning and let the Tauri shell still launch
    // (with the lock-screen biometric button disabled). The validation
    // failure above is the only thing that blocks compilation entirely.
    #[cfg(target_os = "macos")]
    build_swift_biometric();

    // ── Node sidecar (Bun --compile, all platforms) ───────────────────────
    //
    // Compile the Node/TypeScript sidecar to a single self-contained
    // executable via `bun build --compile`. Same externalBin pattern as the
    // Swift biometric: `binaries/graphnosis-sidecar-<rust-target-triple>`.
    // The Tauri shell spawns it via tauri-plugin-shell's sidecar() API at
    // runtime — no Node required on the user's machine.
    //
    // Like the Swift build, this must precede tauri_build::build() so the
    // externalBin file existence check passes. Build failure is non-fatal
    // (logged as cargo:warning) — without the sidecar the App boots into a
    // visible error state instead of failing compilation, which makes
    // local-dev iteration on Rust-only changes possible without re-running
    // bun every time.
    build_node_sidecar();

    // ── MCP relay (Bun --compile, all platforms) ───────────────────────────
    //
    // The MCP relay is the stdio↔Unix-socket byte pipe that Claude Desktop
    // spawns to talk to the App's sidecar. Pre-compile: Claude needed a
    // system Node to run `node mcp-relay.js`. Post-compile: Claude spawns
    // `graphnosis-mcp-relay-<triple>` directly, zero Node dependency.
    //
    // Same externalBin pattern as the sidecar — Tauri's bundler picks the
    // binary up from `binaries/`, copies to `Contents/MacOS/` in the .app.
    // The `configure_claude_desktop` command rewrites Claude's mcp.json to
    // point at this binary instead of `node + relay.js`.
    build_node_binary(
        "graphnosis-mcp-relay",
        "src/mcp-relay.ts",
    );

    // ── Native dylib companions ──────────────────────────────────────────
    //
    // Bun's --compile extracts embedded .node native modules to a temp dir
    // at runtime, but does NOT extract sibling shared libraries that those
    // .node files load via @rpath/@loader_path. fastembed → onnxruntime-node
    // is the immediate offender: its `onnxruntime_binding.node` references
    // `@rpath/libonnxruntime.1.21.0.dylib` which lives next to the .node
    // file in the npm package. Without the dylib, embeddings fail at
    // dlopen() and the sidecar falls back to TF-IDF-only retrieval.
    //
    // Strategy: copy the dylib into BOTH `target/<profile>/` (so dev mode
    // finds it next to the running sidecar) and `resources/` (so Tauri's
    // bundler ships it into the .app's Contents/Resources/). At sidecar
    // spawn time, Rust sets DYLD_FALLBACK_LIBRARY_PATH to point at both
    // locations so dyld's @rpath fallback search picks up the dylib.
    copy_onnxruntime_dylib();

    tauri_build::build();
}

#[cfg(target_os = "macos")]
fn build_swift_biometric() {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let swift_src = manifest_dir.join("swift/graphnosis-biometric.swift");

    // Tauri's bundled-sidecar resolution expects:
    //   `<externalBin>-<rust-target-triple>`
    // e.g. binaries/graphnosis-biometric-aarch64-apple-darwin
    let target = std::env::var("TARGET").unwrap_or_else(|_| {
        if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin".to_string()
        } else {
            "x86_64-apple-darwin".to_string()
        }
    });

    let binaries_dir = manifest_dir.join("binaries");
    let _ = std::fs::create_dir_all(&binaries_dir);
    let binary_path = binaries_dir.join(format!("graphnosis-biometric-{}", target));

    println!("cargo:rerun-if-changed={}", swift_src.display());

    // Skip swiftc entirely if the binary already exists and is at least as
    // new as the source. Without this, every cargo build (including the
    // ones Tauri's dev watcher kicks off) re-writes the binary, which —
    // even with .taurignore covering `binaries/` — burns several seconds
    // of swiftc time per iteration for no reason. Belt-and-suspenders
    // protection against the Tauri-watch infinite loop if .taurignore is
    // ever misplaced or deleted.
    if let (Ok(src_meta), Ok(bin_meta)) = (
        std::fs::metadata(&swift_src),
        std::fs::metadata(&binary_path),
    ) {
        if let (Ok(src_mtime), Ok(bin_mtime)) = (src_meta.modified(), bin_meta.modified()) {
            if bin_mtime >= src_mtime {
                // Binary is up-to-date — skip swiftc, but ALWAYS ensure
                // the runtime copy exists at target/<profile>/. The
                // runtime copy is what tauri-plugin-shell's sidecar
                // resolver looks for at exec time; if it's missing
                // (different profile, cleaned target dir, fresh clone),
                // we silently fix it here.
                ensure_runtime_copy(&manifest_dir, &target, &binary_path);
                return;
            }
        }
    }

    // Invoke `xcrun swiftc` rather than swiftc directly. Cargo build scripts
    // run with a stripped environment that strips SDKROOT/DEVELOPER_DIR/etc.;
    // calling swiftc bare in that env produces "unable to load standard
    // library for target …" because the SDK paths aren't resolved. `xcrun`
    // sets those env vars from the active Xcode selection before exec'ing
    // swiftc, which fixes the stdlib lookup on swift-6.x + macOS 26 CLT.
    //
    // `-sectcreate __TEXT __info_plist swift/Info.plist` embeds an Info.plist
    // into the compiled binary's __TEXT,__info_plist section. macOS reads
    // CFBundleDisplayName from this section when rendering the Touch ID
    // prompt and the Privacy & Security panel, so the user sees
    // "Graphnosis Biometric" instead of the raw filename.
    let plist_path = manifest_dir.join("swift/Info.plist");
    let status = Command::new("xcrun")
        .args(["swiftc", "-O"])
        .arg("-Xlinker").arg("-sectcreate")
        .arg("-Xlinker").arg("__TEXT")
        .arg("-Xlinker").arg("__info_plist")
        .arg("-Xlinker").arg(&plist_path)
        .arg("-o")
        .arg(&binary_path)
        .arg(&swift_src)
        .status();

    match status {
        Ok(s) if s.success() => {
            println!(
                "cargo:warning=built biometric sidecar at {}",
                binary_path.display()
            );
            ensure_runtime_copy(&manifest_dir, &target, &binary_path);
        }
        Ok(s) => {
            println!(
                "cargo:warning=swiftc exited with status {} — biometric sidecar will be unavailable",
                s
            );
        }
        Err(e) => {
            println!(
                "cargo:warning=could not run swiftc ({}); biometric sidecar will be unavailable",
                e
            );
        }
    }
}

#[cfg(target_os = "macos")]
fn ensure_runtime_copy(manifest_dir: &std::path::Path, target: &str, source: &std::path::Path) {
    ensure_runtime_copy_named(manifest_dir, target, source, "graphnosis-biometric");
}

/// Mirror a compiled sidecar binary from `binaries/` to `target/<profile>/`.
///
/// tauri-plugin-shell's `Command::new_sidecar(name)` at RUNTIME looks for
/// `<exe-dir>/<name>-<triple>` next to the main app binary — for dev that's
/// `target/<profile>/`. The bundled release build uses the `binaries/` path
/// via the externalBin config in tauri.conf.json, so we keep BOTH copies:
/// one in `binaries/` (release / bundler input) and one in `target/<profile>/`
/// (dev runtime resolution). Without the second copy, dev mode errors with
/// "No such file or directory" when spawning the sidecar.
///
/// Generalised over `name` so the same routine serves both the Swift
/// biometric sidecar and the Bun-compiled Node sidecar.
fn ensure_runtime_copy_named(
    manifest_dir: &std::path::Path,
    target: &str,
    source: &std::path::Path,
    name: &str,
) {
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let runtime_dir = manifest_dir.join("target").join(&profile);
    if let Err(e) = std::fs::create_dir_all(&runtime_dir) {
        println!(
            "cargo:warning=could not create {}: {} — {} may fail at runtime",
            runtime_dir.display(), e, name
        );
        return;
    }
    let runtime_path = runtime_dir.join(format!("{}-{}", name, target));

    // Only re-copy if missing or stale to avoid spamming the file watcher
    // (binaries/ is already in .taurignore, but target/<profile>/ is not).
    if let (Ok(src_meta), Ok(dst_meta)) = (
        std::fs::metadata(source),
        std::fs::metadata(&runtime_path),
    ) {
        if let (Ok(src_t), Ok(dst_t)) = (src_meta.modified(), dst_meta.modified()) {
            if dst_t >= src_t {
                return; // up-to-date
            }
        }
    }

    match std::fs::copy(source, &runtime_path) {
        Ok(_) => {
            println!(
                "cargo:warning=copied {} to {} (runtime path)",
                name, runtime_path.display()
            );
        }
        Err(e) => {
            println!(
                "cargo:warning=could not copy {} to {}: {}",
                name, runtime_path.display(), e
            );
        }
    }
}

// ── Node sidecar build ─────────────────────────────────────────────────
//
// All platforms. `bun build --compile` produces a single Mach-O / ELF / PE
// executable that bundles:
//   - Bun runtime
//   - All transpiled TypeScript from apps/desktop-sidecar/src/
//   - All workspace dependencies (@graphnosis-app/core,
//     @nehloo-interactive/graphnosis-secure-sync, @nehloo/graphnosis)
//   - All npm deps including libsodium-wrappers-sumo, fastembed, onnxruntime
//
// Output: `binaries/graphnosis-sidecar-<rust-target-triple>`
//
// Trade-off vs shipping Node + dist: +0 MB of separate Node, single binary,
// no system-Node version dependency. Cost: requires Bun on the build
// machine. We don't gate the build behind it though — missing Bun is a
// non-fatal cargo:warning so devs working on Rust-only changes don't have
// to install Bun just to compile the App.

fn build_node_sidecar() {
    build_node_binary("graphnosis-sidecar", "src/index.ts");
}

/// Generic Bun --compile builder for any sidecar/relay entry under
/// `apps/desktop-sidecar/`. Used for both the main sidecar (src/index.ts)
/// and the MCP relay (src/mcp-relay.ts).
///
/// `binary_name` is the externalBin base name (no triple suffix); the final
/// binary lands at `binaries/<binary_name>-<rust-target-triple>` so Tauri's
/// bundler picks it up.
///
/// `entry_relative` is the TS entry file relative to the sidecar workspace.
fn build_node_binary(binary_name: &str, entry_relative: &str) {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let workspace_root = manifest_dir
        .parent().expect("apps/desktop")
        .parent().expect("apps")
        .parent().expect("workspace root")
        .to_path_buf();
    let sidecar_dir = workspace_root.join("apps").join("desktop-sidecar");
    let entry_path = sidecar_dir.join(entry_relative);
    if !entry_path.exists() {
        println!(
            "cargo:warning={} entry not found at {} — build skipped",
            binary_name, entry_path.display()
        );
        return;
    }

    let target = std::env::var("TARGET").unwrap_or_else(|_| {
        if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin".to_string()
        } else {
            "x86_64-apple-darwin".to_string()
        }
    });
    let bun_target = rust_triple_to_bun_target(&target);

    let binaries_dir = manifest_dir.join("binaries");
    let _ = std::fs::create_dir_all(&binaries_dir);
    let binary_path = binaries_dir.join(format!("{}-{}", binary_name, target));

    // ── Watch set for cargo + the mtime guard ──────────────────────────
    //
    // Bun bundles the sidecar AND every workspace dependency the sidecar
    // imports from. The naive watch list (sidecar src only) misses
    // changes in `packages/graphnosis-app-core/` and produced a real bug:
    // bumping app-core's secure-sync pin to v0.1.2 didn't rebuild the
    // Bun binary because none of the sidecar's src files had moved, so
    // the binary kept embedding the OLD secure-sync's crypto module
    // (with `createRequire('libsodium-wrappers-sumo')` → runtime crash).
    //
    // Watch list now includes:
    //   - apps/desktop-sidecar/src         — TS sources that bun --compile bundles
    //   - apps/desktop-sidecar/package.json — sidecar's own deps
    //   - packages/graphnosis-app-core/dist — the workspace dep bun walks into.
    //                                          We watch dist/ (not src/) because
    //                                          that's what bun actually reads —
    //                                          the package.json `"main"` points
    //                                          at dist/index.js.
    //   - packages/graphnosis-app-core/package.json — workspace-dep version pins
    //
    // NOT watched (deliberate): pnpm-lock.yaml. It changes on every
    // `pnpm install` workspace-wide, even for unrelated packages, and
    // would force a Bun recompile every time. The two file-level
    // package.jsons above catch the changes that actually matter.
    let watch_paths: &[std::path::PathBuf] = &[
        sidecar_dir.join("src"),
        sidecar_dir.join("package.json"),
        workspace_root.join("packages").join("graphnosis-app-core").join("dist"),
        workspace_root.join("packages").join("graphnosis-app-core").join("package.json"),
    ];
    for p in watch_paths {
        println!("cargo:rerun-if-changed={}", p.display());
    }

    // Skip the compile entirely if the binary is already newer than every
    // file in the watch set. Returns the max mtime across all watched
    // paths so a change to any of them triggers a rebuild.
    if let Ok(bin_meta) = std::fs::metadata(&binary_path) {
        let bin_mtime = bin_meta.modified().ok();
        let newest_src_mtime: Option<std::time::SystemTime> = watch_paths
            .iter()
            .filter_map(|p| walk_newest_mtime(p))
            .max();
        if let (Some(bm), Some(sm)) = (bin_mtime, newest_src_mtime) {
            if bm >= sm {
                #[cfg(target_os = "macos")]
                ensure_runtime_copy_named(&manifest_dir, &target, &binary_path, binary_name);
                return;
            }
        }
    }

    let bun_path = locate_bun();
    let bun = match bun_path {
        Some(p) => p,
        None => {
            println!(
                "cargo:warning=bun not found (looked in ~/.bun/bin, %USERPROFILE%\\.bun\\bin, and PATH); \
                 {} build SKIPPED. Install from https://bun.sh",
                binary_name
            );
            return;
        }
    };

    println!(
        "cargo:warning=compiling {} with bun --compile (target={}, output={})",
        binary_name, bun_target, binary_path.display()
    );

    // On Windows targets, ask Bun to bake the "Windows GUI subsystem" flag
    // into the PE so Windows never allocates a console window for the
    // resulting binary. Without this, both the sidecar (spawned by Rust)
    // and the MCP relay (spawned by Claude Desktop) pop up a black console
    // window every launch. Rust's CREATE_NO_WINDOW spawn flag handles our
    // own spawn, but only the PE subsystem flag covers the relay because
    // we don't control how Claude Desktop spawns it.
    //
    // Important caveat: Bun's --windows-hide-console only takes effect when
    // building NATIVELY on Windows. When cross-compiling from macOS or Linux
    // (`--target=bun-windows-x64` from a non-Windows host), the flag is a
    // silent no-op — Bun reuses the upstream Windows-built bun binary
    // wholesale and can't rewrite its PE subsystem. So the relay window will
    // still pop up on Claude Desktop spawn unless the release is built on a
    // Windows runner. The sidecar window is suppressed in both cases via the
    // Rust spawn flag in sidecar.rs.
    let mut bun_args: Vec<String> = vec![
        "build".to_string(),
        entry_path.to_string_lossy().into_owned(),
        "--compile".to_string(),
        format!("--target={}", bun_target),
    ];
    if bun_target.starts_with("bun-windows-") {
        bun_args.push("--windows-hide-console".to_string());
    }
    bun_args.push("--outfile".to_string());

    let status = Command::new(&bun)
        .current_dir(&sidecar_dir)
        .args(&bun_args)
        .arg(&binary_path)
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:warning={} built at {}", binary_name, binary_path.display());
            // Embed rpath entries so the .node native addon's @rpath dependency on
            // libonnxruntime.1.21.0.dylib resolves in production. DYLD_FALLBACK_LIBRARY_PATH
            // is silently stripped by macOS for hardened-runtime (notarized) binaries, so the
            // env-var approach in sidecar.rs only works in dev. Baking the paths in here means
            // Tauri re-signs the binary with the correct rpaths already present.
            //   @executable_path/           → target/<profile>/   (dev, next to binary)
            //   @executable_path/../Resources/resources  → Contents/Resources/resources/ (bundled .app)
            #[cfg(target_os = "macos")]
            {
                let _ = Command::new("install_name_tool")
                    .args([
                        "-add_rpath", "@executable_path/",
                        "-add_rpath", "@executable_path/../Resources/resources",
                    ])
                    .arg(&binary_path)
                    .status();
            }
            #[cfg(target_os = "macos")]
            ensure_runtime_copy_named(&manifest_dir, &target, &binary_path, binary_name);
        }
        Ok(s) => {
            println!(
                "cargo:warning=bun build exited with status {} — {} will be unavailable",
                s, binary_name
            );
        }
        Err(e) => {
            println!(
                "cargo:warning=could not run bun ({}); {} will be unavailable",
                e, binary_name
            );
        }
    }
}

/// Map a Rust target triple to the Bun `--target` value. Bun and Rust use
/// different shorthand for the same platform/arch combinations.
fn rust_triple_to_bun_target(triple: &str) -> String {
    match triple {
        "aarch64-apple-darwin" => "bun-darwin-arm64",
        "x86_64-apple-darwin" => "bun-darwin-x64",
        "aarch64-unknown-linux-gnu" => "bun-linux-arm64",
        "x86_64-unknown-linux-gnu" => "bun-linux-x64",
        "x86_64-pc-windows-msvc" => "bun-windows-x64",
        // Fallback: hand it through verbatim and let Bun report an error
        // if it doesn't recognize the target.
        other => return other.to_string(),
    }
    .to_string()
}

/// Find Bun in common locations. Returns None if not found.
fn locate_bun() -> Option<std::path::PathBuf> {
    let bun_exe = if cfg!(windows) { "bun.exe" } else { "bun" };

    // 1. Default install path (~/.bun/bin/bun or %USERPROFILE%\.bun\bin\bun.exe)
    if let Some(home) = dirs_home() {
        let local = home.join(".bun").join("bin").join(bun_exe);
        if local.exists() { return Some(local); }
    }
    // 2. Homebrew (Apple Silicon / Intel — macOS only)
    #[cfg(not(windows))]
    {
        let brew_arm = std::path::PathBuf::from("/opt/homebrew/bin/bun");
        if brew_arm.exists() { return Some(brew_arm); }
        let brew_intel = std::path::PathBuf::from("/usr/local/bin/bun");
        if brew_intel.exists() { return Some(brew_intel); }
    }
    // 3. PATH fallback — `where` on Windows, `which` elsewhere
    let finder = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = std::process::Command::new(finder).arg("bun").output() {
        if out.status.success() {
            // `where` may return multiple lines; take the first non-empty one
            let s = String::from_utf8_lossy(&out.stdout)
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim()
                .to_string();
            if !s.is_empty() {
                let p = std::path::PathBuf::from(s);
                if p.exists() { return Some(p); }
            }
        }
    }
    None
}

/// Tiny re-implementation of dirs::home_dir for build.rs.
/// Windows uses USERPROFILE; Unix uses HOME.
fn dirs_home() -> Option<std::path::PathBuf> {
    if cfg!(windows) {
        std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)
    } else {
        std::env::var_os("HOME").map(std::path::PathBuf::from)
    }
}

/// Copy the onnxruntime shared library next to the sidecar binary (both in
/// `target/<profile>/` for dev mode and in `resources/` for the Tauri
/// bundler). Best-effort: missing pnpm path produces a cargo:warning but
/// doesn't fail the build — the sidecar's embeddings already fall back to
/// TF-IDF when the dylib can't be loaded.
fn copy_onnxruntime_dylib() {
    use std::path::PathBuf;

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let workspace_root = manifest_dir
        .parent().expect("apps/desktop")
        .parent().expect("apps")
        .parent().expect("workspace root")
        .to_path_buf();

    // Map host arch to the onnxruntime-node arch directory layout.
    let (os_subdir, arch_subdir) = if cfg!(target_os = "macos") {
        ("darwin", if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" })
    } else if cfg!(target_os = "linux") {
        ("linux", if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" })
    } else if cfg!(target_os = "windows") {
        ("win32", "x64")
    } else {
        println!("cargo:warning=unsupported OS for onnxruntime dylib bundling — skipping");
        return;
    };

    let dylib_name = match cfg!(target_os = "macos") {
        true => "libonnxruntime.1.21.0.dylib",
        false => match cfg!(target_os = "linux") {
            true => "libonnxruntime.so.1.21.0",
            false => "onnxruntime.dll",
        },
    };

    // pnpm flattens onnxruntime-node into .pnpm/<pkg>@<version>/node_modules/
    // The exact directory name includes a content hash on some installs, so
    // we glob the .pnpm dir for the first match. Avoids pinning to a specific
    // pnpm version's directory layout.
    let pnpm_dir = workspace_root.join("node_modules").join(".pnpm");
    let source = find_onnxruntime_dylib(&pnpm_dir, os_subdir, arch_subdir, dylib_name);
    let Some(source) = source else {
        println!(
            "cargo:warning=onnxruntime dylib not found under {} — embeddings will fall back to TF-IDF in compiled mode",
            pnpm_dir.display()
        );
        return;
    };
    println!("cargo:rerun-if-changed={}", source.display());

    // Destination 1: dev runtime — next to target/<profile>/graphnosis-app.
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let dev_dir = manifest_dir.join("target").join(&profile);
    let _ = std::fs::create_dir_all(&dev_dir);
    let dev_path = dev_dir.join(dylib_name);
    copy_if_stale(&source, &dev_path, "dev runtime");

    // Destination 2: Tauri bundle resource — copied into Contents/Resources/.
    let resources_dir = manifest_dir.join("resources");
    let _ = std::fs::create_dir_all(&resources_dir);
    let resource_path = resources_dir.join(dylib_name);
    copy_if_stale(&source, &resource_path, "bundle resource");
}

fn find_onnxruntime_dylib(
    pnpm_dir: &std::path::Path,
    os_subdir: &str,
    arch_subdir: &str,
    dylib_name: &str,
) -> Option<std::path::PathBuf> {
    // Look for any `onnxruntime-node@*` directory and pick the first that
    // contains the expected dylib.
    if let Ok(entries) = std::fs::read_dir(pnpm_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let n = name.to_string_lossy();
            if !n.starts_with("onnxruntime-node@") { continue; }
            let candidate = entry.path()
                .join("node_modules")
                .join("onnxruntime-node")
                .join("bin")
                .join("napi-v3")
                .join(os_subdir)
                .join(arch_subdir)
                .join(dylib_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn copy_if_stale(source: &std::path::Path, dest: &std::path::Path, label: &str) {
    if let (Ok(src_meta), Ok(dst_meta)) = (
        std::fs::metadata(source),
        std::fs::metadata(dest),
    ) {
        if let (Ok(s), Ok(d)) = (src_meta.modified(), dst_meta.modified()) {
            if d >= s { return; }
        }
    }
    match std::fs::copy(source, dest) {
        Ok(_) => println!("cargo:warning=copied {} → {} ({})", source.display(), dest.display(), label),
        Err(e) => println!("cargo:warning=could not copy {} → {}: {} ({})", source.display(), dest.display(), e, label),
    }
}

/// Recursively find the newest mtime in a tree. Used by the sidecar
/// compile to decide whether a rebuild is needed. Returns None if the path
/// doesn't exist or can't be read.
fn walk_newest_mtime(path: &std::path::Path) -> Option<std::time::SystemTime> {
    let meta = std::fs::metadata(path).ok()?;
    let mut newest = meta.modified().ok();
    if meta.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                if let Some(sub) = walk_newest_mtime(&entry.path()) {
                    newest = Some(match newest {
                        None => sub,
                        Some(prev) => if sub > prev { sub } else { prev },
                    });
                }
            }
        }
    }
    newest
}


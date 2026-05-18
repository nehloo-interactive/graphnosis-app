// graphnosis-biometric.swift
//
// Tiny Swift sidecar that gates the Graphnosis unlock with macOS biometric
// authentication (Touch ID, or whatever other biometric method LocalAuth
// surfaces on this Mac). Spawned by the Tauri shell as a separate process
// so we don't have to wire objc2 / LocalAuthentication.framework bindings
// into Rust.
//
// Usage:
//   graphnosis-biometric --check          # probe availability, exits 0/1
//   graphnosis-biometric --prompt "..."   # show biometric prompt, exits 0/2
//
// Exit codes:
//   0 → success (or biometric is available, in --check mode)
//   1 → biometric not available (no Touch ID hardware, or no enrolled finger)
//   2 → biometric failed (user cancelled, too many wrong attempts, …)
//   3 → invalid args
//
// Stdout reports a one-line status: "OK" / "UNAVAILABLE: …" / "FAIL: …".
// The Rust caller parses the exit code; stdout is just for human eyes.

import Foundation
import LocalAuthentication

let args = CommandLine.arguments

// Args are parsed loosely so we accept either "--check" / "--prompt <reason>".
// Anything else exits 3 with usage.
guard args.count >= 2 else {
    FileHandle.standardError.write(
        "usage: graphnosis-biometric --check | --prompt <reason>\n".data(using: .utf8)!
    )
    exit(3)
}

let mode = args[1]
let context = LAContext()

// Use deviceOwnerAuthenticationWithBiometrics to require BIOMETRIC (Touch
// ID); fall through to deviceOwnerAuthentication (allow Mac login password)
// only if biometric is unavailable. This matches the user's mental model:
// "I clicked the Touch ID button, ask for my fingerprint."
let policy: LAPolicy = .deviceOwnerAuthenticationWithBiometrics

var policyError: NSError?
let canEval = context.canEvaluatePolicy(policy, error: &policyError)

if mode == "--check" {
    if canEval {
        print("OK")
        exit(0)
    } else {
        let msg = policyError?.localizedDescription ?? "biometric not configured"
        print("UNAVAILABLE: \(msg)")
        exit(1)
    }
}

guard mode == "--prompt" else {
    FileHandle.standardError.write(
        "unknown mode: \(mode)\n".data(using: .utf8)!
    )
    exit(3)
}

// Reason is shown in the system biometric prompt; required by Apple.
let reason = args.count >= 3 ? args[2] : "Authenticate"

guard canEval else {
    let msg = policyError?.localizedDescription ?? "biometric not configured"
    print("UNAVAILABLE: \(msg)")
    exit(1)
}

// evaluatePolicy is async with a completion handler; gate the process exit
// behind a semaphore so we don't return before the user has answered.
let sem = DispatchSemaphore(value: 0)
var success = false
var errorMessage = ""

context.evaluatePolicy(policy, localizedReason: reason) { ok, err in
    success = ok
    if let err = err {
        errorMessage = err.localizedDescription
    }
    sem.signal()
}

sem.wait()

if success {
    print("OK")
    exit(0)
} else {
    print("FAIL: \(errorMessage)")
    exit(2)
}

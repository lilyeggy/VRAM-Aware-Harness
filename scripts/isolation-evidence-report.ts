import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { release as osRelease } from "node:os";

import type { SandboxRuntimeEvidence, SandboxSpec } from "../src/sandbox/sandbox-profile.ts";
import type { EffectivePolicySnapshot } from "../src/policies/effective-policy.ts";
import {
    fingerprintSandboxSpec,
} from "../src/evidence/sandbox-spec-fingerprint.ts";
import {
    makeEnvironmentFingerprint,
    probeCpuVirt,
} from "../src/evidence/environment-fingerprint.ts";
import {
    runEvidenceChecks,
    type IsolationEvidence,
} from "../src/evidence/isolation-evidence.ts";
import {
    buildIsolationTriple,
    verifyIsolationTriple,
} from "../src/evidence/isolation-triple.ts";

/**
 * Isolation evidence report (regression gate).
 *
 * Collects the environment facts + an optional runtime-evidence/spec fingerprint
 * and runs the project's isolation assertions. It is the audit-facing entry
 * point for "did the sandbox actually run the way we claimed".
 *
 *   HARNESS_EVIDENCE_RUNTIME_EVIDENCE_JSON   optional SandboxRuntimeEvidence JSON
 *   HARNESS_EVIDENCE_SPEC_JSON               optional compiled SandboxSpec JSON
 *   HARNESS_EVIDENCE_POLICY_JSON             optional EffectivePolicySnapshot JSON
 *
 * Exit: 0 = PASS/WARN, 1 = FAIL (fail-closed regression gate).
 */

function runCmd(command: string): string | null {
    try {
        const out = execSync(command, { encoding: "utf8", timeout: 10_000 });
        const first = out.trim().split("\n")[0];
        return first.length > 0 ? first : null;
    } catch {
        return null;
    }
}

function versionLine(versionOutput: string | null, label: string): string | null {
    if (versionOutput === null) return null;
    const re = new RegExp(
        label === "docker"
            ? /Docker version ([\w.\-]+)/
            : /version ([\w.\-]+)/,
    );
    const match = versionOutput.match(re);
    return match ? match[1] : versionOutput;
}

function collectEnvironment() {
    const dockerVersion = versionLine(runCmd("docker --version"), "docker");
    const runcVersion = versionLine(runCmd("runc --version"), "runc");
    const runscVersion = versionLine(runCmd("runsc --version"), "runsc");
    return makeEnvironmentFingerprint({
        platform: process.platform,
        kernel: osRelease(),
        cpuVirt: probeCpuVirt(),
        kvmDevice: existsSync("/dev/kvm"),
        dockerVersion,
        runcVersion,
        runscVersion,
    });
}

function readOptionalJson<T>(envName: string): T | null {
    const raw = process.env[envName];
    if (raw === undefined) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

const environment = collectEnvironment();

const runtimeEvidence: SandboxRuntimeEvidence | null =
    readOptionalJson<SandboxRuntimeEvidence>("HARNESS_EVIDENCE_RUNTIME_EVIDENCE_JSON");

const spec: SandboxSpec | null =
    readOptionalJson<SandboxSpec>("HARNESS_EVIDENCE_SPEC_JSON");
const specFingerprint = spec === null ? null : fingerprintSandboxSpec(spec);

const policy: EffectivePolicySnapshot | null =
    readOptionalJson<EffectivePolicySnapshot>("HARNESS_EVIDENCE_POLICY_JSON");

// Evidence triple: intent(policy) <-> product(spec) <-> fact(runtime).
const triple = policy !== null && spec !== null
    ? buildIsolationTriple({ policy, specFingerprint, runtimeEvidence })
    : null;
const tripleVerdict = triple === null ? null : verifyIsolationTriple(triple);

const evidence: IsolationEvidence = {
    runtimeEvidence,
    specFingerprint,
    environment,
};

const report = runEvidenceChecks(evidence);

const output = {
    result: report.result,
    generatedAt: new Date().toISOString(),
    environment,
    runtimeEvidence,
    specFingerprint,
    policyFingerprint: triple?.policyFingerprint ?? null,
    isolationTriple: triple,
    tripleConsistent: tripleVerdict?.consistent ?? null,
    tripleNotes: tripleVerdict?.notes ?? [],
    checks: report.checks,
};

console.log(JSON.stringify(output, null, 2));

if (report.result === "FAIL") {
    process.exitCode = 1;
}

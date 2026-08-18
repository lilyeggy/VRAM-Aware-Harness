import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxRuntimeEvidence, SandboxSpec } from "../../src/sandbox/sandbox-profile.ts";
import {
    canonicalSandboxSpec,
    fingerprintSandboxSpec,
} from "../../src/evidence/sandbox-spec-fingerprint.ts";
import {
    makeEnvironmentFingerprint,
    probeCpuVirt,
} from "../../src/evidence/environment-fingerprint.ts";
import {
    defaultEvidenceChecks,
    runEvidenceChecks,
    type IsolationEvidence,
} from "../../src/evidence/isolation-evidence.ts";

function makeSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
    return {
        profile: "default",
        runtime: "runsc",
        image: "alpine:3.20",
        userId: 65532,
        workspaceMount: "/workspace",
        workspacePath: "/srv/workspaces/tenant-a/run",
        networkMode: "none",
        readOnlyRootfs: true,
        droppedCapabilities: "ALL",
        noNewPrivileges: true,
        pidLimit: 128,
        resourceLimits: { cpuCores: null, memoryMiB: null, diskMiB: null },
        secretNames: ["TOKEN"],
        ...overrides,
    };
}

function evidence(overrides: Partial<IsolationEvidence> = {}): IsolationEvidence {
    return {
        runtimeEvidence: {
            adapter: "docker-runsc",
            requestedRuntime: "runsc",
            observedRuntime: "runsc",
            verified: true,
            verificationReason: null,
            verifiedAt: "2026-08-18T00:00:00.000Z",
        },
        specFingerprint: fingerprintSandboxSpec(makeSpec()),
        environment: makeEnvironmentFingerprint({
            runscVersion: "release-20260810.0",
            dockerVersion: "29.7.2",
        }),
        ...overrides,
    };
}

test("spec 指纹是确定性的：同边界的两次编译得到同一指纹", () => {
    expect(fingerprintSandboxSpec(makeSpec())).toBe(
        fingerprintSandboxSpec(makeSpec()),
    );
});

test("spec 指纹与实例化路径无关（只反映隔离边界）", () => {
    const a = fingerprintSandboxSpec(makeSpec({ workspacePath: "/x/a" }));
    const b = fingerprintSandboxSpec(makeSpec({ workspacePath: "/y/z/b" }));
    expect(a).toBe(b);
});

test("资源限制变化会改变指纹", () => {
    const base = fingerprintSandboxSpec(makeSpec());
    const capped = fingerprintSandboxSpec(makeSpec({
        resourceLimits: { cpuCores: 2, memoryMiB: 512, diskMiB: null },
    }));
    expect(base).not.toBe(capped);
});

test("secret 列表排序稳定，顺序不影响指纹", () => {
    const a = canonicalSandboxSpec(makeSpec({ secretNames: ["B", "A"] }));
    const b = canonicalSandboxSpec(makeSpec({ secretNames: ["A", "B"] }));
    expect(a).toBe(b);
});

test("环境指纹可注入构造", () => {
    const f = makeEnvironmentFingerprint({
        platform: "linux",
        kernel: "6.8.0",
        cpuVirt: ["vmx"],
        kvmDevice: false,
        dockerVersion: "29.7.2",
        runscVersion: "release-20260810.0",
    });
    expect(f.platform).toBe("linux");
    expect(f.cpuVirt).toEqual(["vmx"]);
    expect(f.runscVersion).toBe("release-20260810.0");
});

test("probeCpuVirt 从 /proc 风格文本识别 vmx/svm", () => {
    const dir = mkdtempSync(join(tmpdir(), "cpuinfo-"));
    const file = join(dir, "cpuinfo");
    writeFileSync(file, [
        "processor : 0",
        "flags\t\t: fpu vme de pse tsc",
        "processor : 1",
        "flags\t\t: vmx svm ht",
        "",
    ].join("\n"));
    const flags = probeCpuVirt(file);
    expect(flags).toContain("vmx");
    expect(flags).toContain("svm");
});

test("无处理器虚拟化标志时返回空数组", () => {
    const dir = mkdtempSync(join(tmpdir(), "cpuinfo2-"));
    const file = join(dir, "cpuinfo");
    writeFileSync(file, "flags\t\t: fpu de pse\n");
    expect(probeCpuVirt(file)).toEqual([]);
});

test("已证实的 runsc 证据 + 指纹 + 运行时存在 => PASS", () => {
    const report = runEvidenceChecks(evidence(), defaultEvidenceChecks);
    expect(report.result).toBe("PASS");
    const runtime = report.checks.find((c) => c.id === "runtime_verified");
    expect(runtime?.status).toBe("PASS");
});

test("未证实的 runtime 证据 => FAIL（fail-closed，不把配置声明当证据）", () => {
    const unverified: SandboxRuntimeEvidence = {
        ...evidence().runtimeEvidence!,
        verified: false,
        observedRuntime: null,
        verificationReason: "等待 Docker inspect",
    };
    const report = runEvidenceChecks(evidence({ runtimeEvidence: unverified }));
    expect(report.result).toBe("FAIL");
    expect(report.checks.find((c) => c.id === "runtime_verified")?.status).toBe("FAIL");
});

test("观测 runtime 与请求不一致 => FAIL", () => {
    const mismatch: SandboxRuntimeEvidence = {
        ...evidence().runtimeEvidence!,
        observedRuntime: "runc",
    };
    const report = runEvidenceChecks(evidence({ runtimeEvidence: mismatch }));
    expect(report.result).toBe("FAIL");
    const c = report.checks.find((x) => x.id === "runtime_claim_matches_evidence");
    expect(c?.status).toBe("FAIL");
});

test("缺少 spec 指纹 => 降级为 WARN 而非 FAIL", () => {
    const report = runEvidenceChecks(evidence({ specFingerprint: null }));
    expect(report.result).toBe("WARN");
    expect(report.checks.find((c) => c.id === "spec_fingerprint_present")?.status)
        .toBe("WARN");
});

test("microVM 门槛信息不计入最终判定（真实标注不等于通过）", () => {
    const report = runEvidenceChecks(evidence());
    const micro = report.checks.find((c) => c.id === "microvm_claim_honest");
    expect(micro?.status).toBe("INFO");
});

test("是否有 KVM 只影响 microVM 信息的措辞，不影响 verdict", () => {
    const withKvm = runEvidenceChecks(evidence({
        environment: makeEnvironmentFingerprint({ cpuVirt: ["vmx"], kvmDevice: true, runscVersion: "release-20260810.0" }),
    }));
    const without = runEvidenceChecks(evidence({
        environment: makeEnvironmentFingerprint({ cpuVirt: [], kvmDevice: false, runscVersion: "release-20260810.0" }),
    }));
    expect(withKvm.result).toBe("PASS");
    expect(without.result).toBe("PASS");
    const a = withKvm.checks.find((c) => c.id === "microvm_claim_honest")?.detail ?? "";
    const b = without.checks.find((c) => c.id === "microvm_claim_honest")?.detail ?? "";
    expect(a).not.toBe(b);
});

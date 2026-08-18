import { expect, test } from "bun:test";
import type { EffectivePolicySnapshot } from "../../src/policies/effective-policy.ts";
import type { SandboxRuntimeEvidence, SandboxSpec } from "../../src/sandbox/sandbox-profile.ts";
import { OciSandboxSpecCompiler } from "../../src/sandbox/oci-sandbox-spec.ts";
import { fingerprintSandboxSpec } from "../../src/evidence/sandbox-spec-fingerprint.ts";
import { policyBoundaryFingerprint } from "../../src/evidence/policy-boundary-fingerprint.ts";
import {
    buildIsolationTriple,
    verifyIsolationTriple,
    type IsolationTriple,
} from "../../src/evidence/isolation-triple.ts";

function makePolicy(overrides: Partial<EffectivePolicySnapshot> = {}): EffectivePolicySnapshot {
    return {
        id: "policy-1",
        runId: "run",
        tenantId: "tenant",
        templateVersionId: "template",
        createdAt: "2026-08-18T00:00:00.000Z",
        sandboxProfile: "default",
        allowedTools: null,
        allowedSkills: null,
        allowedModels: null,
        workspaceRoots: ["/srv/workspaces/tenant"],
        allowNetwork: false,
        allowProcess: false,
        allowedSecrets: ["TOKEN"],
        resourceLimits: { cpuCores: null, memoryMiB: null, diskMiB: null },
        layers: [],
        ...overrides,
    };
}

function runscEvidence(overrides: Partial<SandboxRuntimeEvidence> = {}): SandboxRuntimeEvidence {
    return {
        adapter: "docker-runsc",
        requestedRuntime: "runsc",
        observedRuntime: "runsc",
        verified: true,
        verificationReason: null,
        verifiedAt: "2026-08-18T00:00:00.000Z",
        ...overrides,
    };
}

test("策略边界指纹：相同边界 -> 相同指纹，业务身份字段不影响", () => {
    const a = policyBoundaryFingerprint(makePolicy());
    const b = policyBoundaryFingerprint(makePolicy({
        id: "different",
        runId: "different-run",
        tenantId: "another-tenant",
        createdAt: "2099-01-01",
    }));
    expect(a).toBe(b);
});

test("策略边界指纹：允许网络变化会改变指纹", () => {
    expect(policyBoundaryFingerprint(makePolicy())).not.toBe(
        policyBoundaryFingerprint(makePolicy({ allowNetwork: true })),
    );
});

test("策略边界指纹：资源限制变化会改变指纹", () => {
    expect(policyBoundaryFingerprint(makePolicy())).not.toBe(
        policyBoundaryFingerprint(makePolicy({
            resourceLimits: { cpuCores: 2, memoryMiB: 512, diskMiB: null },
        })),
    );
});

test("isolation-triple：真实编译器同一策略编译 -> spec 指纹稳定且三元组自洽", () => {
    const policy = makePolicy();
    const compiler = new OciSandboxSpecCompiler({
        image: "alpine:3.20",
        userId: 65532,
        profile: "default",
        runtime: "runsc",
    });
    const ws = "/srv/workspaces/tenant/run";
    const secrets = policy.allowedSecrets ?? [];
    const compiledA = compiler.compile("a", ws, policy, secrets);
    const compiledB = compiler.compile("b", ws, policy, secrets);

    const fpA = fingerprintSandboxSpec(compiledA.spec);
    const fpB = fingerprintSandboxSpec(compiledB.spec);
    expect(fpA).toBe(fpB);

    const triple = buildIsolationTriple({
        policy,
        specFingerprint: fpA,
        runtimeEvidence: runscEvidence(),
    });
    // 用重新编译的 spec 指纹做重算校验，应一致
    const verdict = verifyIsolationTriple(triple, { recompiledSpecFingerprint: fpB });
    expect(verdict.consistent).toBe(true);
    expect(verdict.notes).toEqual([]);
});

test("isolation-triple：被限制的策略编译出的 spec 指纹与默认策略不同", () => {
    const compiler = new OciSandboxSpecCompiler({
        image: "alpine:3.20",
        userId: 65532,
        profile: "default",
        runtime: "runsc",
    });
    const ws = "/srv/workspaces/tenant/run";
    const baseSpec = compiler.compile("a", ws, makePolicy(), ["TOKEN"]).spec;
    const cappedSpec = compiler.compile("b", ws, makePolicy({
        resourceLimits: { cpuCores: 2, memoryMiB: 512, diskMiB: null },
    }), ["TOKEN"]).spec;
    expect(fingerprintSandboxSpec(baseSpec)).not.toBe(
        fingerprintSandboxSpec(cappedSpec as SandboxSpec),
    );
});

test("verifyIsolationTriple fail-closed：runtime 未证实 -> 不一致", () => {
    const triple = buildIsolationTriple({
        policy: makePolicy(),
        specFingerprint: "abcdef1234567890",
        runtimeEvidence: runscEvidence({ verified: false, observedRuntime: null }),
    });
    const verdict = verifyIsolationTriple(triple);
    expect(verdict.consistent).toBe(false);
    expect(verdict.notes.some((n) => n.includes("inspect"))).toBe(true);
});

test("verifyIsolationTriple fail-closed：观测 runtime != 请求 runtime -> 不一致", () => {
    const triple = buildIsolationTriple({
        policy: makePolicy(),
        specFingerprint: "abcdef1234567890",
        runtimeEvidence: runscEvidence({ observedRuntime: "runc" }),
    });
    expect(verifyIsolationTriple(triple).consistent).toBe(false);
});

test("verifyIsolationTriple：重编译指纹漂移 -> 不一致", () => {
    const triple = buildIsolationTriple({
        policy: makePolicy(),
        specFingerprint: "recorded-fingerprint",
        runtimeEvidence: runscEvidence(),
    });
    const verdict = verifyIsolationTriple(triple, {
        recompiledSpecFingerprint: "different-fingerprint",
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.notes.some((n) => n.includes("漂移"))).toBe(true);
});

test("verifyIsolationTriple：三元组全部自洽 -> 一致", () => {
    const triple: IsolationTriple = {
        policyFingerprint: "aaaa0000",
        specFingerprint: "bbbb1111",
        runtimeEvidence: runscEvidence(),
    };
    expect(verifyIsolationTriple(triple).consistent).toBe(true);
});

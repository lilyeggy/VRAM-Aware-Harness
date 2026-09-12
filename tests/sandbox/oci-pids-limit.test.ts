import { expect, test } from "bun:test";

import type { EffectivePolicySnapshot } from "../../src/policies/effective-policy.ts";
import { OciSandboxSpecCompiler } from "../../src/sandbox/oci-sandbox-spec.ts";

function makePolicy(overrides: Partial<EffectivePolicySnapshot> = {}): EffectivePolicySnapshot {
    return {
        id: "policy-pids",
        runId: "run",
        tenantId: "tenant",
        templateVersionId: "template",
        createdAt: "2026-09-11T00:00:00.000Z",
        sandboxProfile: "default",
        allowedTools: null,
        allowedSkills: null,
        allowedModels: null,
        workspaceRoots: ["/srv/workspaces/tenant"],
        allowNetwork: false,
        allowProcess: false,
        allowedSecrets: null,
        resourceLimits: { cpuCores: null, memoryMiB: null, diskMiB: null },
        layers: [],
        ...overrides,
    };
}

const WORKSPACE = "/srv/workspaces/tenant/run";

test("N14：未配置时沿用 128，并进入可审计的 spec 指纹", () => {
    const compiler = new OciSandboxSpecCompiler({
        image: "alpine:3.20",
        userId: 65532,
        profile: "default",
        runtime: "runsc",
    });
    const policy = makePolicy();
    const compiled = compiler.compile("pid-default", WORKSPACE, policy, []);

    expect(compiled.spec.pidLimit).toBe(128);
    expect(compiled.createArgs).toContain("--pids-limit");
    expect(compiled.createArgs[compiled.createArgs.indexOf("--pids-limit") + 1]).toBe("128");
});

test("N14：可用 HARNESS_CONTAINER_PIDS_LIMIT 覆盖，调到 gVisor 内部上限之下", () => {
    const compiler = new OciSandboxSpecCompiler({
        image: "alpine:3.20",
        userId: 65532,
        profile: "default",
        runtime: "runsc",
        pidsLimit: 64,
    });
    const policy = makePolicy();
    const compiled = compiler.compile("pid-64", WORKSPACE, policy, []);

    expect(compiled.spec.pidLimit).toBe(64);
    expect(compiled.createArgs[compiled.createArgs.indexOf("--pids-limit") + 1]).toBe("64");
});

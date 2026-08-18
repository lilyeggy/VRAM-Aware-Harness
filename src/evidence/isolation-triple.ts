import type { EffectivePolicySnapshot } from "../policies/effective-policy.ts";
import type { SandboxRuntimeEvidence } from "../sandbox/sandbox-profile.ts";
import { policyBoundaryFingerprint } from "./policy-boundary-fingerprint.ts";

/**
 * The evidence triple binds three facts of one isolated run:
 *
 *   intent  ──compile──►  product  ──observe──►  fact
 *   policy    (specFingerprint)    runtimeEvidence
 *   fingerprint
 *
 * A run is only "as advertised" if the recorded spec really is what this
 * policy compiles to *and* the runtime actually observed matches it. This is
 * the auditable chain behind "we ran exactly what we said, in the isolation
 * we said".
 */
export interface IsolationTriple {
    readonly policyFingerprint: string;
    readonly specFingerprint: string;
    readonly runtimeEvidence: SandboxRuntimeEvidence | null;
}

export interface TripleVerificationOptions {
    /**
     * A freshly recompiled spec fingerprint from the same policy. When supplied,
     * the recorded triple is re-checked against it — any drift means the policy
     * or the compiler changed under us.
     */
    readonly recompiledSpecFingerprint?: string;
}

export interface TripleVerdict {
    readonly consistent: boolean;
    readonly notes: readonly string[];
}

export function buildIsolationTriple(input: {
    policy: EffectivePolicySnapshot;
    specFingerprint: string;
    runtimeEvidence: SandboxRuntimeEvidence | null;
}): IsolationTriple {
    return Object.freeze({
        policyFingerprint: policyBoundaryFingerprint(input.policy),
        specFingerprint: input.specFingerprint,
        runtimeEvidence: input.runtimeEvidence,
    });
}

/**
 * Fail-closed consistency check of the triple: any missing/conflicting link
 * makes the whole run inconsistent. Runtime evidence, when present, must be
 * inspect-verified and match the requested runtime.
 */
export function verifyIsolationTriple(
    triple: IsolationTriple,
    options: TripleVerificationOptions = {},
): TripleVerdict {
    const notes: string[] = [];
    let consistent = true;

    if (triple.policyFingerprint.length === 0) {
        consistent = false;
        notes.push("策略边界指纹缺失");
    }
    if (triple.specFingerprint.length === 0) {
        consistent = false;
        notes.push("编译边界指纹缺失");
    }

    if (
        options.recompiledSpecFingerprint !== undefined
        && options.recompiledSpecFingerprint !== triple.specFingerprint
    ) {
        consistent = false;
        notes.push(
            `spec 指纹与重新编译不一致（记录=${triple.specFingerprint} 重算=${options.recompiledSpecFingerprint}）：策略或编译过程已漂移`,
        );
    }

    if (triple.runtimeEvidence !== null) {
        if (!triple.runtimeEvidence.verified) {
            consistent = false;
            notes.push("runtime 未被实际 inspect 证实（仅配置声明）");
        } else if (
            triple.runtimeEvidence.observedRuntime
                !== triple.runtimeEvidence.requestedRuntime
        ) {
            consistent = false;
            notes.push(
                `观测 runtime（${triple.runtimeEvidence.observedRuntime ?? "无"}）!= 请求 runtime（${triple.runtimeEvidence.requestedRuntime}）`,
            );
        }
    }

    return {
        consistent,
        notes: Object.freeze(notes),
    };
}

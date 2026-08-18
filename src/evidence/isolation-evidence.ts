import type { SandboxRuntimeEvidence } from "../sandbox/sandbox-profile.ts";
import type { EnvironmentFingerprint } from "./environment-fingerprint.ts";

export type EvidenceStatus = "PASS" | "WARN" | "FAIL" | "INFO";

export interface EvidenceCheckResult {
    readonly id: string;
    readonly description: string;
    readonly status: EvidenceStatus;
    readonly detail: string;
}

/** Everything needed to decide, for one codebase/environment, whether the isolation story holds. */
export interface IsolationEvidence {
    readonly runtimeEvidence: SandboxRuntimeEvidence | null;
    readonly specFingerprint: string | null;
    readonly environment: EnvironmentFingerprint;
}

export interface IsolationReport {
    readonly result: "PASS" | "WARN" | "FAIL";
    readonly checks: readonly EvidenceCheckResult[];
}

export type EvidenceCheck = (evidence: IsolationEvidence) => EvidenceCheckResult;

/**
 * Default assertions encode the project's honesty rules:
 *  - runtime is what was claimed AND Docker inspect proved it (fail-hard);
 *  - the compiled boundary has a deterministic fingerprint;
 *  - microVM/strict is never claimed verified without KVM (info, not pass).
 */
export const defaultEvidenceChecks: readonly EvidenceCheck[] = [
    (e) => {
        const ev = e.runtimeEvidence;
        const detail = ev === null
            ? "该次运行没有 runtime 证据"
            : `adapter=${ev.adapter} requested=${ev.requestedRuntime} observed=${ev.observedRuntime ?? "无"}`;
        return {
            id: "runtime_verified",
            description: "目标 runtime 已被实际 inspect 证实（非仅配置声明）",
            status: ev?.verified === true ? "PASS" : "FAIL",
            detail,
        };
    },
    (e) => {
        const ev = e.runtimeEvidence;
        const detail = ev === null
            ? "无证据"
            : `requested=${ev.requestedRuntime} observed=${ev.observedRuntime ?? "无"}`;
        return {
            id: "runtime_claim_matches_evidence",
            description: "请求的 runtime 与实际运行 runtime 一致",
            status: ev !== null && ev.observedRuntime === ev.requestedRuntime ? "PASS" : "FAIL",
            detail,
        };
    },
    (e) => ({
        id: "spec_fingerprint_present",
        description: "编译出的隔离边界具有确定性指纹（可复现/可追溯）",
        status: e.specFingerprint ? "PASS" : "WARN",
        detail: e.specFingerprint ?? "未提供 spec 指纹",
    }),
    (e) => {
        const hasKvm = e.environment.cpuVirt.length > 0 || e.environment.kvmDevice;
        return {
            id: "microvm_claim_honest",
            description: "microVM（strict 档）的门槛是否如实标注",
            status: "INFO",
            detail: hasKvm
                ? "当前环境提供 KVM：microVM 路线可在真机验证"
                : "当前环境无 KVM / 无 CPU 虚拟化扩展：microVM 仅作为 strict 演进方向，不声明已通过",
        };
    },
    (e) => {
        const runsc = e.environment.runscVersion;
        const runc = e.environment.runcVersion;
        const present = runsc !== null || runc !== null;
        return {
            id: "runtime_detected",
            description: "检测到可用的容器运行时（runsc/runc）",
            status: present ? "PASS" : "WARN",
            detail: `runsc=${runsc ?? "无"} runc=${runc ?? "无"}`,
        };
    },
];

/**
 * Runs assertions and collapses INFO out of the result: any FAIL fails hard
 * (fail-closed), otherwise any WARN degrades to WARN. INFO is reported but does
 * not affect the verdict.
 */
export function runEvidenceChecks(
    evidence: IsolationEvidence,
    checks: readonly EvidenceCheck[] = defaultEvidenceChecks,
): IsolationReport {
    const all = checks.map((check) => check(evidence));
    const verdicts = all.filter((r) => r.status !== "INFO");
    const hasFail = verdicts.some((r) => r.status === "FAIL");
    const hasWarn = verdicts.some((r) => r.status === "WARN");
    return {
        result: hasFail ? "FAIL" : hasWarn ? "WARN" : "PASS",
        checks: Object.freeze(all),
    };
}

import type {
    PolicyDecision,
} from "../../src/resources/execution-policy.ts";
import type {
    PolicyDecisionRecorder,
} from "../../src/resources/policy-decision-store.ts";
import type {
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";

export interface RecordedPolicyDecision {
    decision: PolicyDecision;
    snapshot: ResourceSnapshot | null;
}

/**
 * Admission Service 测试只关心“是否要求持久化”，不需要连接 SQLite。
 * PolicyDecisionStore 自己的数据库行为由独立测试覆盖。
 */
export class FakePolicyDecisionRecorder
implements PolicyDecisionRecorder {
    readonly records: RecordedPolicyDecision[] = [];

    save(
        decision: PolicyDecision,
        snapshot: ResourceSnapshot | null,
    ): void {
        this.records.push({ decision, snapshot });
    }
}

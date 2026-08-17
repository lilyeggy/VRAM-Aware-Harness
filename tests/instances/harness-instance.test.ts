import { expect, test } from "bun:test";

import {
    createHarnessInstance,
    transitionHarnessInstance,
} from "../../src/instances/harness-instance.ts";

const createdAt = "2026-08-10T10:00:00.000Z";

function instance() {
    return createHarnessInstance({
        id: "instance-1",
        tenantId: "tenant-1",
        templateVersionId: "template-version-1",
        capabilityProfileId: "capability-profile-1",
        runtimeKind: "PI",
        createdAt,
    });
}

test("HarnessInstance 只允许显式生命周期转换", () => {
    const provisioning = instance();
    const ready = transitionHarnessInstance(
        provisioning,
        "READY",
        "2026-08-10T10:00:01.000Z",
    );
    const active = transitionHarnessInstance(
        ready,
        "ACTIVE",
        "2026-08-10T10:00:02.000Z",
    );

    expect(active.actualState).toBe("ACTIVE");
    expect(() => transitionHarnessInstance(
        active,
        "PROVISIONING",
        "2026-08-10T10:00:03.000Z",
    )).toThrow("非法 HarnessInstance 状态转换");
});

test("FAILED Instance 必须保留失败原因", () => {
    expect(() => transitionHarnessInstance(
        instance(),
        "FAILED",
        "2026-08-10T10:00:01.000Z",
    )).toThrow("必须且只能携带 failureReason");

    const failed = transitionHarnessInstance(
        instance(),
        "FAILED",
        "2026-08-10T10:00:01.000Z",
        "sandbox lost",
    );
    expect(failed.failureReason).toBe("sandbox lost");
});

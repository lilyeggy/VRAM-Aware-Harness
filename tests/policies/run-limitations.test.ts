import { describe, expect, test } from "bun:test";

import { summarizeToolDenials } from "../../src/policies/run-limitations.ts";

/**
 * N3 回归：受环境约束未完成的任务终态仍是 COMPLETED（产品现状），
 * 但 Run 详情必须能从工具策略 DENY 账本聚合出结构化 limitations，
 * 让"已完成但受限"在 API 层可辨识，而不是靠读 500 字回答分辨。
 */

describe("N3：DENY 账本聚合为 limitations", () => {
    test("同工具同原因合并计数，ALLOW 不进入", () => {
        const limitations = summarizeToolDenials([
            { toolName: "bash", action: "DENY", reason: "执行环境无法隔离 Workspace，拒绝 bash", decidedAt: "2026-09-10T05:00:00.000Z" },
            { toolName: "write", action: "ALLOW", reason: "有效策略允许工具调用", decidedAt: "2026-09-10T05:00:01.000Z" },
            { toolName: "bash", action: "DENY", reason: "执行环境无法隔离 Workspace，拒绝 bash", decidedAt: "2026-09-10T05:00:02.000Z" },
            { toolName: "edit", action: "DENY", reason: "策略禁止工具启动进程", decidedAt: "2026-09-10T05:00:03.000Z" },
        ]);
        expect(limitations).toHaveLength(2);
        const bash = limitations.find((l) => l.toolName === "bash");
        expect(bash).toEqual({
            toolName: "bash",
            reason: "执行环境无法隔离 Workspace，拒绝 bash",
            count: 2,
            lastDecidedAt: "2026-09-10T05:00:02.000Z",
        });
        expect(limitations.every((l) => l.count > 0)).toBe(true);
    });

    test("无 DENY 的干净 Run 产出空 limitations", () => {
        expect(summarizeToolDenials([
            { toolName: "write", action: "ALLOW", reason: "有效策略允许工具调用", decidedAt: "2026-09-10T05:00:00.000Z" },
        ])).toEqual([]);
        expect(summarizeToolDenials([])).toEqual([]);
    });
});

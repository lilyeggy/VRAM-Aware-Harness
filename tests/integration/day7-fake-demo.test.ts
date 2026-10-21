import { expect, test } from "bun:test";

import {
    formatDay7FakeDemoReport,
    runDay7FakeDemo,
} from "../../scripts/demo/day7-fake-demo.ts";

test("demo:day7 用并发上限制造排队，并覆盖重启恢复与完整审计证据", async () => {
    const report = await runDay7FakeDemo();

    // 全局并发上限 = 1：一个 Run 执行时，另一个只能真实排队。
    expect(report.queueAtConcurrencyLimit).toHaveLength(1);
    expect(report.queueAtConcurrencyLimit[0]?.reasonCode).toBe(
        "GLOBAL_CONCURRENCY_LIMIT",
    );
    expect(report.startRunIds).toHaveLength(1);
    expect(report.resumeRunIds).toHaveLength(1);
    expect(report.runs.map((item) => item.run.status))
        .toEqual(["COMPLETED", "COMPLETED"]);
    expect(report.runs[0]?.timeline).toContain("RUN_INTERRUPTED");
    expect(report.runs[0]?.timeline).toContain("RUN_RESUMED");

    const output = formatDay7FakeDemoReport(report);
    expect(output).toContain("[CONCURRENCY LIMIT] queue snapshot");
    expect(output).toContain("runtime.resume");
    expect(output).toContain("limitations:");
    expect(output).toContain("RESULT: PASS");
});

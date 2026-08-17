import { expect, test } from "bun:test";

import {
    formatDay7FakeDemoReport,
    runDay7FakeDemo,
} from "../../src/demo/day7-fake-demo.ts";

test("demo:day7 输出资源排队、重启恢复和完整审计证据", async () => {
    const report = await runDay7FakeDemo();

    expect(report.queueAtCritical).toHaveLength(2);
    expect(report.queueAtCritical.every(
        (entry) => entry.reasonCode === "RESOURCE_CRITICAL",
    )).toBe(true);
    expect(report.startRunIds).toHaveLength(1);
    expect(report.resumeRunIds).toHaveLength(1);
    expect(report.runs.map((item) => item.run.status))
        .toEqual(["COMPLETED", "COMPLETED"]);
    expect(report.runs[0]?.timeline).toContain("RUN_INTERRUPTED");
    expect(report.runs[0]?.timeline).toContain("RUN_RESUMED");
    expect(report.runs.every((item) =>
        item.decisions.at(-1)?.action === "START"
    )).toBe(true);

    const output = formatDay7FakeDemoReport(report);
    expect(output).toContain("[CRITICAL] queue snapshot");
    expect(output).toContain("runtime.resume");
    expect(output).toContain("policy decisions:");
    expect(output).toContain("RESULT: PASS");
});

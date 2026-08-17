import {expect,test} from "bun:test";

import {
    assertValidTransition,
    canTransition
} from "../../src/runs/run-state-machine";


test("QUEUED可以转换为 RUNNING",() => {
    expect(canTransition("QUEUED","RUNNING")).toBe(true);
    expect(() => {
        assertValidTransition("QUEUED","RUNNING");
    }).not.toThrow();
});

test("COMPLETED 不能转化为 RUNNING",() => {
    expect(canTransition("COMPLETED","RUNNING")).toBe(false);
    expect(() => {
        assertValidTransition("COMPLETED","RUNNING");
    }).toThrow("非法的 AgentRun 状态转换");
})
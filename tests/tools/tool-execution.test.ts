import {expect,test} from "bun:test";

import {
    canAutomaticallyReplay,
}   from "../../src/tools/tool-execution.ts"

test("允许自动重放尚未完成的只读工具",()=>{
    expect(
        canAutomaticallyReplay("PREPARED","READ_ONLY")
    ).toBe(true);
    expect(
        canAutomaticallyReplay("PREPARED","IDEMPOTENT_WRITE")
    ).toBe(false);
    expect(
        canAutomaticallyReplay("PREPARED","UNKNOWN_EFFECT")
    ).toBe(false);
    expect(
        canAutomaticallyReplay("SUCCEEDED","READ_ONLY")
    ).toBe(false);
    expect(
        canAutomaticallyReplay("FAILED","READ_ONLY")
    ).toBe(false);
})

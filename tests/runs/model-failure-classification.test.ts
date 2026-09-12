import { describe, expect, test } from "bun:test";

import { classifyModelFailure } from "../../src/runs/run-service.ts";

/**
 * N6 回归：真机 50k 字符任务 4 次 ~60s 超时后报 "Stream ended without
 * finish_reason"，超限输入报 "400 status code (no body)"——用户与运维都无法
 * 从中判断是超时还是超限。归类后保留原文但前置可读原因。
 */

describe("N6：模型失败信息归类", () => {
    test("流式中断归为超时/断流并保留原文", () => {
        const out = classifyModelFailure("Stream ended without finish_reason");
        expect(out).toContain("模型流式响应中断");
        expect(out).toContain("Stream ended without finish_reason");
    });

    test("无 body 的 4xx 归为后端拒绝并提示常见原因", () => {
        const out = classifyModelFailure("400 status code (no body)");
        expect(out).toContain("模型后端拒绝请求");
        expect(out).toContain("HTTP 400");
        expect(out).toContain("上下文");
    });

    test("其它错误原样透传，不改语义", () => {
        expect(classifyModelFailure("RUN_FAILED 自定义原因")).toBe("RUN_FAILED 自定义原因");
        expect(classifyModelFailure("500 status code (oops)")).toBe("500 status code (oops)");
    });
});

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const script = readFileSync(
    new URL("../../scripts/sandbox-security-probe.ts", import.meta.url),
    "utf8",
);
const report = readFileSync(
    new URL("../../docs/production-full-flow-report.zh-CN.md", import.meta.url),
    "utf8",
);

describe("沙箱隔离性探针（平台侧下探）", () => {
    test("不经过 Agent/HTTP，直接用 provider.execute 下探 guest", () => {
        expect(script.includes("provider.execute(")).toBe(true);
        expect(script.includes("fetch(")).toBe(false);
        expect(script.includes("MicrovmSandboxProvider")).toBe(true);
        expect(script.includes("HARNESS_PROBE_ROOT")).toBe(true);
    });

    test("覆盖 13 项隔离检查", () => {
        const checks = [
            "guest.只有 lo 网卡",
            "guest.无出网成功标记",
            "guest.uid=0",
            "guest.kernel 4.14.174",
            "guest.被授权的 secret 注入成功",
            "guest.宿主模型 key 未进入沙箱",
            "guest.看不到宿主家目录",
            "guest.找不到宿主数据库",
            "guest.rootfs 只读",
            "guest./tmp 可写",
            "guest./workspace 可写",
            "跨沙箱.看不到对方工作区文件",
            "跨沙箱.未获授权的 secret 未注入",
        ];
        for (const name of checks) {
            expect(script.includes(name)).toBe(true);
        }
        expect(script.includes("SANDBOX_SECURITY_PROBE_")).toBe(true);
        expect(script.includes('"OK" : "FAIL"')).toBe(true);
    });

    test("cross-sandbox 判定不靠全串搜索（探针文本本身含 marker-a.txt）", () => {
        expect(script.includes("ownListing")).toBe(true);
        expect(script.includes("own workspace 仅 lost+found")).toBe(true);
    });

    test("报告记录模型拒答动因与真机 13 项结果", () => {
        expect(report.includes("模型拒答")).toBe(true);
        expect(report.includes("SANDBOX_SECURITY_PROBE_OK")).toBe(true);
        expect(report.includes("跨沙箱")).toBe(true);
    });
});

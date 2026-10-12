import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const guide = readFileSync(
    new URL("../../docs/vm-technology-guide.zh-CN.html", import.meta.url),
    "utf8",
);
const explained = readFileSync(
    new URL("../../docs/vm-creation-explained.zh-CN.html", import.meta.url),
    "utf8",
);

describe("VM 文档数字保持最新（O3–O11 之后）", () => {
    test("vm-technology-guide 记录当前热恢复/冷启动数字与 A/B", () => {
        for (const token of [
            "498.3 ms",
            "175.9 ms",
            "101.3 ms",
            "HARNESS_VM_SHARE_ROOTFS=1",
            "261ms",
            "539",
            "753~756 ms",
            "snapshot-reuse",
            "HARNESS_VM_SNAPSHOT_TYPE=Diff",
            "常驻 running 待机 VM",
        ]) {
            expect(guide.includes(token)).toBe(true);
        }
    });

    test("vm-technology-guide 不再保留被推翻的旧结论", () => {
        for (const stale of [
            "热恢复 490ms 里时间花在哪",
            "其余仍按冷启动走，这是已知的优化点",
            "方案中的预热池被删",
        ]) {
            expect(guide.includes(stale)).toBe(false);
        }
    });

    test("vm-creation-explained 反映静态 C agent 与握手量化修复", () => {
        for (const token of [
            "::respawn:/agent/main",
            "974,536 字节",
            "不需要 socat",
            "HARNESS_GUEST_AGENT_IMPL=bun",
            "由 Firecracker 的 vsock 设备（VMM）回",
            "每 50ms 重试一次",
        ]) {
            expect(explained.includes(token)).toBe(true);
        }
        expect(explained.includes("socat 监听 vsock 5000 → agent")).toBe(false);
        expect(explained.includes("说明 socat 接住了连接")).toBe(false);
    });
});

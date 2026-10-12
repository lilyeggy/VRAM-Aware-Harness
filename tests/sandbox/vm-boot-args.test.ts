import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), "utf8");

const BOOT_MARK_PHASES = [
    "proc-sysfs",
    "mdev",
    "tmpfs",
    "workspace",
    "before-socat",
];

describe("冷启动：内核参数默认值与 guest 分段埋点", () => {
    it("默认内核命令行关闭 i8042 探测（真机冷启动 1338ms → 539ms 的关键）", () => {
        const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain(
            'export const COLD_START_BOOT_ARGS = "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/init i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd"',
        );
        // 两条分支（默认 / verbose）都必须带上，否则排障时又回到 1.3s
        expect(driver).toContain("${COLD_START_BOOT_ARGS} quiet loglevel=3 printk.time=1");
        expect(driver).toContain("${COLD_START_BOOT_ARGS} printk.time=1 loglevel=7 initcall_debug");
        // 不重编镜像就能调内核：HARNESS_VM_EXTRA_BOOT_ARGS 追加在末尾
        expect(driver).toContain("readonly extraBootArgs?: string;");
        expect(driver).toContain('process.env.HARNESS_VM_EXTRA_BOOT_ARGS ?? ""');
        expect(driver).toContain("private withExtraBootArgs(base: string): string {");
    });

    it("串口落盘开关存在且有默认关闭语义（HARNESS_VM_SERIAL_LOG_DIR）", () => {
        const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain("readonly serialLogDir?: string;");
        expect(driver).toContain("process.env.HARNESS_VM_SERIAL_LOG_DIR ?? null");
        expect(driver).toContain("private writeSerialLog(sandboxId: string, chunk: Buffer | string): void {");
        expect(driver).toContain("appendFileSync(join(dir, `${sandboxId}.serial.log`), chunk)");
    });

    it("构建脚本与补丁脚本写入同一套 inittab 埋点（两边必须一致）", () => {
        const build = read("scripts/microvm/build-guest-rootfs.sh");
        const patch = read("scripts/microvm/patch-guest-rootfs-bootmarks.sh");
        for (const phase of BOOT_MARK_PHASES) {
            const line = `::sysinit:/bin/sh /etc/boot-mark ${phase}`;
            expect(build).toContain(line);
            expect(patch).toContain(line);
        }
        for (const script of [build, patch]) {
            expect(script).toContain("harness-boot ${phase} uptime=${up}");
            expect(script).toContain("read up _rest < /proc/uptime");
            expect(script).toContain("> /dev/console");
            // 只读 rootfs 下的可写层：埋点脚本不能依赖可写 rootfs
            expect(script).toContain("mount -t tmpfs -o mode=1777,size=64m tmpfs /tmp");
        }
    });

    it("补丁脚本幂等、先备份、并且不会静默覆盖未知 inittab 行", () => {
        const patch = read("scripts/microvm/patch-guest-rootfs-bootmarks.sh");
        expect(patch).toContain('echo "PATCH_BOOTMARKS_SKIP 已经包含启动埋点：$IMAGE"');
        expect(patch).toContain('cp -a "$IMAGE" "$IMAGE.bak-bootmarks"');
        expect(patch).toContain('echo "PATCH_BOOTMARKS_OK image=$IMAGE backup=$IMAGE.bak-bootmarks"');
        expect(patch).toContain("inittab 含未知行，拒绝改写");
        expect(patch).toContain('grep -q "harness-boot" "$WORK/verify-mark"');
    });
});

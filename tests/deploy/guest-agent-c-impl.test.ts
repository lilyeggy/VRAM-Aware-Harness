import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const readText = (relative: string): string => readFileSync(resolve(repoRoot, relative), "utf8");

const BUILD_SCRIPT = "scripts/microvm/build-guest-rootfs.sh";
const PATCH_SCRIPT = "scripts/microvm/patch-guest-rootfs-c-agent.sh";
const LEDGER = "docs/vm-startup-optimizations.zh-CN.md";

describe("静态 C guest agent（§9.8 v1.4 冷启动 O9）", () => {
    test("guest/agent/agent.c 是小体积单文件实现，自监听 AF_VSOCK 且协议与 main.ts 一致", () => {
        const sourcePath = resolve(repoRoot, "guest/agent/agent.c");
        expect(existsSync(sourcePath)).toBe(true);
        // 体积必须远小于 96MB 的 Bun --compile 产物，否则本次优化没有意义
        expect(statSync(sourcePath).size).toBeLessThan(200 * 1024);

        const source = readText("guest/agent/agent.c");
        expect(source).toContain("AF_VSOCK");
        expect(source).toContain("VMADDR_CID_ANY");
        expect(source).toContain("listen_vsock");
        expect(source).toContain("harness-agent listening on vsock");
        expect(source).toContain("protocol_frame_too_large");
        expect(source).toContain("exec_result");
        expect(source).toContain("maxOutputBytes");
        expect(source).toContain("timedOut");
        // 旧实现仍在仓库里（impl=bun 回退路径）
        expect(existsSync(resolve(repoRoot, "guest/agent/main.ts"))).toBe(true);
    });

    test("build-guest-rootfs.sh 支持 impl 切换，impl=c 时静态编译并直接 respawn /agent/main", () => {
        const script = readText(BUILD_SCRIPT);
        expect(script).toContain('AGENT_IMPL="${HARNESS_GUEST_AGENT_IMPL:-auto}"');
        expect(script).toContain("AGENT_C_SOURCE=");
        expect(script).toContain('"${CC_BIN}" -O2 -static -Wall -o "${WORKDIR}/harness-agent" "${AGENT_C_SOURCE}"');
        expect(script).toContain("sed -i.bak 's#^::respawn:.*#::respawn:/agent/main#'");
        expect(script).toContain("[OK] inittab respawns /agent/main directly");
        // 两条分支都要有：bun 用传入的二进制，c 用现场编译的
        expect(script).toContain('if [ "${AGENT_IMPL}" = "bun" ]; then');
    });

    test("impl=c 时跳过 socat / OpenSSL / C++ 运行时 apk 拉取（负向依赖），bun 路径保持原样", () => {
        const script = readText(BUILD_SCRIPT);
        const gateIndex = script.indexOf('if [ "${AGENT_IMPL}" = "bun" ]; then');
        const socatIndex = script.indexOf('fetch_apk "socat"');
        const stdcxxIndex = script.indexOf('fetch_apk "libstdc++"');
        expect(gateIndex).toBeGreaterThan(-1);
        expect(socatIndex).toBeGreaterThan(gateIndex);
        expect(stdcxxIndex).toBeGreaterThan(gateIndex);
        expect(script).toContain('if [ "${AGENT_IMPL}" = "bun" ]; then\n    if [ -x "${ROOT_STAGING}/usr/bin/socat" ]; then');
    });

    test("patch-guest-rootfs-c-agent.sh 幂等、先备份、白名单拒绝未知 inittab、回写后 cmp 校验", () => {
        const script = readText(PATCH_SCRIPT);
        expect(script).toContain("PATCH_C_AGENT_SKIP");
        expect(script).toContain('"$IMAGE.bak-cagent"');
        expect(script).toContain("拒绝改写");
        expect(script).toContain('sif /agent/main mode 0100755');
        expect(script).toContain('cmp -s "$AGENT_BIN" "$WORK/verify-agent"');
        expect(script).toContain("PATCH_C_AGENT_OK");
        // 幂等判定必须基于"已经直接 respawn /agent/main"
        expect(script).toContain("if grep -q '^::respawn:/agent/main$' \"$WORK/inittab\"; then");
        // 切换后必须清空快照池（旧黄金快照里是 socat 版 agent）
        expect(script).toContain("清空快照池");
    });

    test("驱动默认 guestAgentVersion=2.0.0 并注明换 agent 必须提升（参与快照模板哈希）", () => {
        const driver = readText("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain('?? "2.0.0"');
        expect(driver).toContain("必须提升它");
        expect(driver).toContain("computeTemplateHash");
    });

    test("台账记录 O9：动机、实现、与 C 工具链约束的显式偏差、复现命令", () => {
        const ledger = readText(LEDGER);
        expect(ledger).toContain("### O9 静态 C guest agent");
        expect(ledger).toContain("35,792 字节");
        expect(ledger).toContain("HARNESS_GUEST_AGENT_IMPL");
        expect(ledger).toContain("PATCH_C_AGENT_OK");
        expect(ledger).toContain("docs/microvm-implementation-plan.md:228");
        expect(ledger).toContain("## 5.1 guest agent 构建与存量镜像切换");
    });

    test("microvm 脚本首行是合法 shebang（生成时不能丢 # 号）", () => {
        const expected = "#" + String.fromCharCode(33) + "/usr/bin/env bash";
        for (const path of [
            "scripts/microvm/patch-guest-rootfs-c-agent.sh",
            "scripts/microvm/build-guest-rootfs.sh",
        ]) {
            expect(readText(path).split("\n")[0]).toBe(expected);
        }
    });
});

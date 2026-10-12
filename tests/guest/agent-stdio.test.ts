import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * guest/agent/agent.c（小体积静态 guest agent）的宿主侧协议测试。
 *
 * 在宿主机上把 C agent 编译出来并用 --stdio 模式驱动，断言它与
 * guest/agent/main.ts（Bun 版）以及 src/sandbox/microvm/firecracker-vsock-bridge.ts
 * 的帧契约逐字兼容。没有可用 C 编译器时整体跳过（CI 环境可能没有 cc）。
 */

const AGENT_SOURCE = resolve(import.meta.dir, "../../guest/agent/agent.c");

function pickCompiler(): string | null {
    const candidates = [process.env.CC, "cc", "clang", "gcc"].filter(
        (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
    for (const candidate of candidates) {
        const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
        if (probe.status === 0) {
            return candidate;
        }
    }
    return null;
}

const compiler = pickCompiler();
const buildDir = join(tmpdir(), "harness-guest-agent-test");
const binaryPath = join(buildDir, "harness-guest-agent");
let buildError: string | null = null;

if (compiler === null) {
    buildError = "找不到 C 编译器（cc/clang/gcc）";
} else {
    mkdirSync(buildDir, { recursive: true });
    const compile = spawnSync(compiler, ["-O2", "-std=c11", "-Wall", "-o", binaryPath, AGENT_SOURCE], {
        encoding: "utf8",
    });
    if (compile.status !== 0) {
        buildError = `编译失败：${compile.stderr || compile.stdout}`;
    } else if (existsSync(binaryPath) === false) {
        buildError = "编译产物不存在";
    }
}

type AgentFrame = {
    v?: number;
    type?: string;
    id?: unknown;
    stream?: string;
    data?: string;
    exitCode?: number;
    timedOut?: boolean;
    truncated?: boolean;
    reason?: string;
};

class AgentClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly frames: AgentFrame[] = [];
    private readonly waiters: Array<(frame: AgentFrame) => void> = [];
    private rest = "";
    private stderrText = "";

    constructor(binary: string) {
        this.child = spawn(binary, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
        this.child.stdout.setEncoding("utf8");
        this.child.stdout.on("data", (chunk: string) => {
            this.rest += chunk;
            let index = this.rest.indexOf("\n");
            while (index >= 0) {
                const line = this.rest.slice(0, index).trim();
                this.rest = this.rest.slice(index + 1);
                if (line.length > 0) {
                    this.deliver(JSON.parse(line) as AgentFrame);
                }
                index = this.rest.indexOf("\n");
            }
        });
        this.child.stderr.setEncoding("utf8");
        this.child.stderr.on("data", (chunk: string) => {
            this.stderrText += chunk;
        });
    }

    get stderr(): string {
        return this.stderrText;
    }

    private deliver(frame: AgentFrame): void {
        const waiter = this.waiters.shift();
        if (waiter === undefined) {
            this.frames.push(frame);
            return;
        }
        waiter(frame);
    }

    send(frame: Record<string, unknown>): void {
        this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    }

    sendRaw(text: string): void {
        this.child.stdin.write(`${text}\n`);
    }

    next(timeoutMs = 5000): Promise<AgentFrame> {
        const buffered = this.frames.shift();
        if (buffered !== undefined) {
            return Promise.resolve(buffered);
        }
        return new Promise<AgentFrame>((resolveFrame, rejectFrame) => {
            const timer = setTimeout(() => {
                rejectFrame(new Error(`等待帧超时（${timeoutMs}ms）；agent stderr=${this.stderrText}`));
            }, timeoutMs);
            this.waiters.push((frame) => {
                clearTimeout(timer);
                resolveFrame(frame);
            });
        });
    }

    async collectUntilResult(id: string, timeoutMs = 8000): Promise<{ outputs: Array<{ stream: string; text: string }>; result: AgentFrame }> {
        const outputs: Array<{ stream: string; text: string }> = [];
        for (;;) {
            const frame = await this.next(timeoutMs);
            if (frame.type === "exec_output" && frame.id === id) {
                outputs.push({
                    stream: frame.stream ?? "",
                    text: Buffer.from(frame.data ?? "", "base64").toString("utf8"),
                });
                continue;
            }
            if (frame.type === "exec_result" && frame.id === id) {
                return { outputs, result: frame };
            }
            throw new Error(`收到非预期帧：${JSON.stringify(frame)}`);
        }
    }

    close(): void {
        this.child.stdin.end();
        this.child.kill("SIGKILL");
    }
}

const suite = buildError === null ? describe : describe.skip;
let workspace = "";
let client: AgentClient;

suite("guest agent（静态 C 实现）协议兼容", () => {
    beforeAll(() => {
        workspace = mkdtempSync(join(tmpdir(), "harness-agent-ws-"));
        client = new AgentClient(binaryPath);
    });

    afterAll(() => {
        client?.close();
        if (workspace.length > 0) {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    test("二进制远小于 bun 产物（冷启动归因的前提）", () => {
        const size = Bun.file(binaryPath).size;
        expect(size).toBeGreaterThan(1024);
        expect(size).toBeLessThan(1_048_576);
    });

    test("ping 回同 id 的 pong（字符串 id）", async () => {
        client.send({ v: 1, type: "ping", id: "p-1" });
        const frame = await client.next();
        expect(frame).toEqual({ v: 1, type: "pong", id: "p-1" });
    });

    test("ping 的数字 id 原样回写（不是字符串化）", async () => {
        client.send({ v: 1, type: "ping", id: 42 });
        const frame = await client.next();
        expect(frame.type).toBe("pong");
        expect(frame.id).toBe(42);
    });

    test("exec：stdout base64 解码 + exec_result 字段", async () => {
        client.send({
            v: 1,
            type: "exec",
            id: "e-stdout",
            argv: ["/bin/echo", "hello-guest"],
            cwd: workspace,
        });
        const { outputs, result } = await client.collectUntilResult("e-stdout");
        expect(outputs).toEqual([{ stream: "stdout", text: "hello-guest\n" }]);
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.truncated).toBe(false);
    });

    test("exec：stderr 单独成帧，退出码透传", async () => {
        client.send({
            v: 1,
            type: "exec",
            id: "e-streams",
            argv: ["/bin/sh", "-c", "echo out-line; echo err-line 1>&2; exit 7"],
            cwd: workspace,
        });
        const { outputs, result } = await client.collectUntilResult("e-streams");
        expect(outputs).toEqual([
            { stream: "stdout", text: "out-line\n" },
            { stream: "stderr", text: "err-line\n" },
        ]);
        expect(result.exitCode).toBe(7);
    });

    test("exec：env 整体替换且默认 PATH 能解析裸命令名", async () => {
        client.send({
            v: 1,
            type: "exec",
            id: "e-env",
            argv: ["printenv", "HARNESS_TEST_SECRET"],
            cwd: workspace,
            env: { HARNESS_TEST_SECRET: "s3cr3t-value" },
        });
        const { outputs, result } = await client.collectUntilResult("e-env");
        expect(outputs[0]?.text.trim()).toBe("s3cr3t-value");
        expect(result.exitCode).toBe(0);
    });

    test("exec：超时先 SIGTERM，exitCode 124 / timedOut=true", async () => {
        client.send({
            v: 1,
            type: "exec",
            id: "e-timeout",
            argv: ["sleep", "30"],
            cwd: workspace,
            timeoutMs: 300,
        });
        const { result } = await client.collectUntilResult("e-timeout");
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).toBe(124);
    });

    test("exec：maxOutputBytes 硬截断并置 truncated", async () => {
        client.send({
            v: 1,
            type: "exec",
            id: "e-truncate",
            argv: ["/bin/sh", "-c", "yes | head -c 200000"],
            cwd: workspace,
            maxOutputBytes: 1000,
        });
        const { outputs, result } = await client.collectUntilResult("e-truncate");
        expect(result.truncated).toBe(true);
        const totalBytes = outputs.reduce((sum, item) => sum + item.text.length, 0);
        expect(totalBytes).toBeLessThanOrEqual(1000);
    });

    test("exec：大输出按 64KB 分帧且顺序拼接无损", async () => {
        client.send({
            v: 1,
            type: "exec",
            id: "e-large",
            argv: ["/bin/sh", "-c", "head -c 200000 /dev/zero | tr '\\0' 'a'"],
            cwd: workspace,
        });
        const { outputs, result } = await client.collectUntilResult("e-large", 15000);
        expect(result.exitCode).toBe(0);
        expect(outputs.length).toBeGreaterThan(1);
        for (const item of outputs) {
            expect(item.text.length).toBeLessThanOrEqual(65536);
        }
        expect(outputs.map((item) => item.text).join("").length).toBe(200000);
    });

    test("exec：子进程被信号杀死时 exitCode=1（与 main.ts 的 code ?? 1 一致）", async () => {
        client.send({
            v: 1,
            type: "exec",
            id: "e-signal",
            argv: ["/bin/sh", "-c", "printf x; kill -9 $$"],
            cwd: workspace,
        });
        const { result } = await client.collectUntilResult("e-signal");
        expect(result.exitCode).toBe(1);
        expect(result.timedOut).toBe(false);
    });

    test("exec：后台孙进程占着管道也不会挂住 agent", async () => {
        const started = Date.now();
        client.send({
            v: 1,
            type: "exec",
            id: "e-bg",
            argv: ["/bin/sh", "-c", "echo hold; sleep 30 & echo bg; exit 0"],
            cwd: workspace,
            timeoutMs: 20000,
        });
        const { result } = await client.collectUntilResult("e-bg", 10000);
        expect(result.exitCode).toBe(0);
        expect(Date.now() - started).toBeLessThan(5000);
    });

    test("协议错误：非法 JSON / 版本不符 / 未知类型 / 缺 argv", async () => {
        client.sendRaw("{ this is not json");
        expect(await client.next()).toEqual({ v: 1, type: "error", id: null, reason: "protocol" });

        client.send({ v: 2, type: "ping", id: "bad-version" });
        expect(await client.next()).toEqual({ v: 1, type: "error", id: null, reason: "protocol" });

        client.send({ v: 1, type: "unknown-op", id: "u-1" });
        expect(await client.next()).toEqual({ v: 1, type: "error", id: "u-1", reason: "protocol" });

        client.send({ v: 1, type: "exec", id: "no-argv", cwd: workspace });
        expect(await client.next()).toEqual({ v: 1, type: "error", id: "no-argv", reason: "protocol" });
    });

    test("协议错误：超长帧返回 protocol_frame_too_large", async () => {
        client.sendRaw(`{"v":1,"type":"ping","id":"${"x".repeat(1_100_000)}"}`);
        const frame = await client.next(15000);
        expect(frame).toEqual({ v: 1, type: "error", id: null, reason: "protocol_frame_too_large" });
        // 之后仍应可正常服务
        client.send({ v: 1, type: "ping", id: "after-oversize" });
        expect(await client.next()).toEqual({ v: 1, type: "pong", id: "after-oversize" });
    });

    test("exec：cwd 不存在时报 Failed to spawn 且 exitCode=127（与 Bun 版语义一致）", async () => {
        client.send({
            v: 1,
            type: "exec",
            id: "e-badcwd",
            argv: ["/bin/echo", "never"],
            cwd: join(workspace, "definitely-missing-dir"),
        });
        const { outputs, result } = await client.collectUntilResult("e-badcwd");
        expect(outputs[0]?.stream).toBe("stderr");
        expect(outputs[0]?.text).toContain("Failed to spawn");
        expect(result.exitCode).toBe(127);
    });
});

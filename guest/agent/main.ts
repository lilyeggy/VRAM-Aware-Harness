import { spawn } from "node:child_process";
import * as readline from "node:readline";

interface ExecRequest {
    v: number;
    type: "exec";
    id: string;
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxOutputBytes?: number;
}

interface PingRequest {
    v: number;
    type: "ping";
    id: string;
}

type IncomingFrame = ExecRequest | PingRequest | Record<string, any>;

function writeFrame(frame: Record<string, any>): void {
    process.stdout.write(JSON.stringify(frame) + "\n");
}

function processFrame(line: string): void {
    if (!line.trim()) {
        return;
    }

    if (Buffer.byteLength(line, "utf8") > 1048576) {
        writeFrame({ v: 1, type: "error", id: null, reason: "protocol_frame_too_large" });
        return;
    }

    let req: IncomingFrame;
    try {
        req = JSON.parse(line);
    } catch {
        writeFrame({ v: 1, type: "error", id: null, reason: "protocol" });
        return;
    }

    if (!req || req.v !== 1 || typeof req.type !== "string") {
        writeFrame({ v: 1, type: "error", id: null, reason: "protocol" });
        return;
    }

    if (req.type === "ping") {
        writeFrame({ v: 1, type: "pong", id: req.id ?? null });
        return;
    }

    if (req.type === "exec") {
        handleExec(req as ExecRequest);
        return;
    }

    writeFrame({ v: 1, type: "error", id: req.id ?? null, reason: "protocol" });
}

function handleExec(req: ExecRequest): void {
    const { id, argv, cwd = "/workspace", env = {}, timeoutMs = 60000, maxOutputBytes = 1048576 } = req;

    if (!id || !Array.isArray(argv) || argv.length === 0) {
        writeFrame({ v: 1, type: "error", id: id ?? null, reason: "protocol" });
        return;
    }

    let timedOut = false;
    let truncated = false;
    let totalOutputBytes = 0;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    let child: ReturnType<typeof spawn>;
    try {
        child = spawn(argv[0], argv.slice(1), {
            cwd,
            // env 全量替换（secret 注入模型）；但必须补默认 PATH，
            // 否则调用方传裸命令名（如 "sync"）时 execvp 无法解析。
            env: {
                PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                ...env,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (err: any) {
        writeFrame({
            v: 1,
            type: "exec_output",
            id,
            stream: "stderr",
            data: Buffer.from(`Failed to spawn: ${err?.message || err}`).toString("base64"),
        });
        writeFrame({
            v: 1,
            type: "exec_result",
            id,
            exitCode: 127,
            timedOut: false,
            truncated: false,
        });
        return;
    }

    if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
            timedOut = true;
            try {
                child.kill("SIGTERM");
            } catch {}
            killTimer = setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                } catch {}
            }, 2000);
        }, timeoutMs);
    }

    const sendChunk = (stream: "stdout" | "stderr", chunk: Buffer) => {
        if (totalOutputBytes >= maxOutputBytes) {
            truncated = true;
            return;
        }

        let slice = chunk;
        if (totalOutputBytes + chunk.length > maxOutputBytes) {
            slice = chunk.subarray(0, maxOutputBytes - totalOutputBytes);
            truncated = true;
        }
        totalOutputBytes += slice.length;

        if (slice.length > 0) {
            // chunk into 64KB pieces if needed
            const chunkSize = 65536;
            for (let i = 0; i < slice.length; i += chunkSize) {
                const sub = slice.subarray(i, i + chunkSize);
                writeFrame({
                    v: 1,
                    type: "exec_output",
                    id,
                    stream,
                    data: sub.toString("base64"),
                });
            }
        }
    };

    child.stdout?.on("data", (chunk: Buffer) => sendChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => sendChunk("stderr", chunk));

    child.on("error", (err: Error) => {
        sendChunk("stderr", Buffer.from(err.message));
    });

    child.on("close", (code) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);

        writeFrame({
            v: 1,
            type: "exec_result",
            id,
            exitCode: code ?? (timedOut ? 124 : 1),
            timedOut,
            truncated,
        });
    });
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
});

rl.on("line", (line) => {
    processFrame(line);
});

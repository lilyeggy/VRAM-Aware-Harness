/**
 * Subprocess Worker Entrypoint.
 *
 * Runs in an isolated OS subprocess (PID != Master PID).
 * Reads line-delimited JSON IPC messages from stdin and streams events to stdout.
 * Manages runsc container and PiAdapter execution.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAdapter } from "../runtime/pi-adapter.ts";
import { ContainerSandboxProvider } from "../sandbox/container-sandbox-provider.ts";
import type { SandboxStore } from "../sandbox/sandbox-store.ts";
import type { SandboxRecord, SecretProvider } from "../sandbox/sandbox-provider.ts";
import {
    createRunCompletedMessage,
    createRunFailedMessage,
    createRunInterruptedMessage,
    createRuntimeEventMessage,
    createWorkerReadyMessage,
    formatJsonLine,
    JsonLineParser,
    type MasterToWorkerMessage,
    type WorkerRuntimeConfig,
    type WorkerToMasterMessage,
} from "./worker-protocol.ts";
import { WorkerToolGateway } from "./worker-tool-gateway.ts";
import {
    DEFAULT_CONTAINER_IMAGE,
    DEFAULT_CONTAINER_USER_ID,
    DEFAULT_PI_MODELS_PATH,
    DEFAULT_PI_PROVIDER,
    DEFAULT_PI_TOOLS,
} from "../app/harness-config.ts";

// 1. Redirect standard logging to stderr to prevent corrupting IPC on stdout
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

function sendToMaster(msg: WorkerToMasterMessage): Promise<void> {
    return new Promise<void>((resolve) => {
        const line = formatJsonLine(msg);
        if (!process.stdout.write(line)) {
            process.stdout.once("drain", resolve);
        } else {
            resolve();
        }
    });
}

// 工具治理网关：所有真实工具执行前都经 Master 裁决并记账（PREPARED→COMPLETE），
// 本进程内不存在旁路放行的工具调用路径。
const toolGateway = new WorkerToolGateway((msg) => {
    void sendToMaster(msg);
});

// 2. Ephemeral Sandbox Store for Worker Container Execution
class EphemeralSandboxStore {
    private readonly records = new Map<string, SandboxRecord>();

    create(record: SandboxRecord): void {
        this.records.set(record.id, record);
    }

    get(id: string): SandboxRecord | null {
        return this.records.get(id) ?? null;
    }

    update(record: SandboxRecord, _previousStatus?: string): void {
        this.records.set(record.id, record);
    }

    listUnsettled(): readonly SandboxRecord[] {
        return [];
    }
}

let activeRunId: string | null = null;
let currentPiAdapter: PiAdapter | null = null;
let isTerminating = false;

// Track pending and acknowledged interrupt requests
const pendingInterruptRunIds = new Set<string>();
const pendingInterruptReasons = new Map<string, string>();
const sentInterruptedRunIds = new Set<string>();

async function notifyInterrupted(runId: string, reason?: string): Promise<void> {
    if (!sentInterruptedRunIds.has(runId)) {
        sentInterruptedRunIds.add(runId);
        await sendToMaster(createRunInterruptedMessage(runId, reason));
    }
}

// 3. Graceful Signal Handling
const handleSignal = async (sig: "SIGTERM" | "SIGINT") => {
    if (isTerminating) return;
    isTerminating = true;
    console.error(`[Worker PID ${process.pid}] Received ${sig}, initiating graceful interrupt`);
    if (activeRunId) {
        pendingInterruptRunIds.add(activeRunId);
        if (currentPiAdapter) {
            try {
                await currentPiAdapter.interrupt(activeRunId);
            } catch (err) {
                console.error(`[Worker PID ${process.pid}] Error during signal interrupt:`, err);
            }
        }
        await notifyInterrupted(activeRunId, `Interrupted by ${sig}`);
    }
    setTimeout(() => {
        process.exit(sig === "SIGTERM" ? 143 : 130);
    }, 10);
};

process.on("SIGTERM", () => void handleSignal("SIGTERM"));
process.on("SIGINT", () => void handleSignal("SIGINT"));

// 4. Runtime Setup Helper
async function setupRuntime(config: WorkerRuntimeConfig, sandboxId?: string, thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high") {
    let containerProvider: ContainerSandboxProvider | undefined;

    if (config.sandboxProvider === "container") {
        const sandboxStore = new EphemeralSandboxStore();
        const secretProvider: SecretProvider = {
            get: (_tenantId, name) => process.env[name] ?? null,
        };

        containerProvider = new ContainerSandboxProvider(
            sandboxStore as unknown as SandboxStore,
            secretProvider,
            {
                image: config.containerImage,
                profile: config.sandboxProfile,
                sandboxRuntime: config.sandboxRuntime === "firecracker" ? "runsc" : config.sandboxRuntime,
                userId: config.containerUserId,
                dockerCommand: config.dockerCommand,
            },
        );

        if (sandboxId) {
            // Register container name mapping for docker exec
            const containerMap = (containerProvider as unknown as { containerBySandboxId?: Map<string, string> }).containerBySandboxId;
            containerMap?.set(sandboxId, `agent-harness-${sandboxId}`);
        }
    }

    const modelRuntime = await ModelRuntime.create({
        modelsPath: config.piModelsPath,
        ...(config.piAuthPath ? { authPath: config.piAuthPath } : {}),
    });

    const piAdapter = new PiAdapter(
        modelRuntime,
        {
            provider: config.piProvider,
            modelId: config.piModelId,
            tools: [...config.piTools],
            ...(thinkingLevel ? { thinkingLevel } : {}),
            // N28 主机制：worker 进程内的 Pi 会话同样要拿到 Harness 下发的
            // 压缩参数，否则长会话在这条路径上仍会静默退化。
            ...(config.piCompaction ? { compaction: config.piCompaction } : {}),
        },
        {
            gateway: toolGateway,
            getLastEventSequence: (runId: string) => toolGateway.getLastEventSequence(runId),
            ...(containerProvider ? { sandboxExecutor: containerProvider } : {}),
        },
    );

    return { piAdapter, containerProvider };
}

// 5. IPC Message Handler
// D9：故障注入逻辑住在独立模块，仅在 HARNESS_WORKER_SIMULATE 显式设置时
// 动态加载——默认生产入口不包含任何注入代码路径。
const simulationMode = process.env.HARNESS_WORKER_SIMULATE;
const faultInjection = simulationMode === undefined
    ? undefined
    : (await import("./worker-fault-injection.ts")).installWorkerFaultInjection(simulationMode, {
        sendToMaster,
        toolGateway,
        pendingInterruptRunIds,
        pendingInterruptReasons,
        notifyInterrupted,
    });

type RunRequestMessage = Extract<MasterToWorkerMessage, { type: "START_RUN" | "RESUME_RUN" }>;

function defaultWorkerConfig(): WorkerRuntimeConfig {
    return {
        piProvider: process.env.PI_PROVIDER ?? DEFAULT_PI_PROVIDER,
        // master 侧 VLLM_MODEL_ID 是必填项；worker 独立运行时保留
        // mock-model 兜底，语义不同，不收敛。
        piModelId: process.env.VLLM_MODEL_ID ?? "mock-model",
        piTools: [...DEFAULT_PI_TOOLS],
        piModelsPath: process.env.PI_MODELS_PATH ?? DEFAULT_PI_MODELS_PATH,
        sandboxProvider: "container",
        sandboxProfile: "default",
        sandboxRuntime: "runsc",
        containerImage: DEFAULT_CONTAINER_IMAGE,
        containerUserId: DEFAULT_CONTAINER_USER_ID,
    };
}

async function executeRunMessage(msg: RunRequestMessage): Promise<void> {
    const isStart = msg.type === "START_RUN";
    const runId = msg.runId;
    activeRunId = runId;

    // Gate 1: Check if already interrupted before START_RUN / RESUME_RUN arrived.
    if (pendingInterruptRunIds.has(runId)) {
        const phase = isStart ? "start" : "resume";
        console.error(`[Worker PID ${process.pid}] Run ${runId} was interrupted before ${phase}, aborting`);
        await notifyInterrupted(runId, pendingInterruptReasons.get(runId) ?? `Interrupted before ${phase}`);
        setTimeout(() => process.exit(0), 10);
        return;
    }

    // D9：故障注入分支全部由按需加载的独立模块消费，生产入口不再散落 mode 判断。
    if (faultInjection) {
        const consumed = isStart
            ? await faultInjection.onStartRun(msg)
            : await faultInjection.onResumeRun(msg);
        if (consumed) return;
    }

    const setupLabel = isStart ? "setup" : "resume setup";
    try {
        const config = msg.workerConfig ?? defaultWorkerConfig();
        const { piAdapter } = await setupRuntime(
            config,
            msg.request.execution?.sandboxId,
            msg.request.run.thinkingLevel,
        );

        // Gate 2: Check if interrupted during asynchronous setupRuntime.
        if (pendingInterruptRunIds.has(runId)) {
            console.error(`[Worker PID ${process.pid}] Run ${runId} interrupted during ${setupLabel}, aborting`);
            await notifyInterrupted(runId, pendingInterruptReasons.get(runId) ?? `Interrupted during ${setupLabel}`);
            return;
        }

        currentPiAdapter = piAdapter;

        const unsubscribe = piAdapter.subscribe(runId, (event) => {
            void sendToMaster(createRuntimeEventMessage(runId, event));
        });

        try {
            if (msg.type === "START_RUN") {
                await piAdapter.start(msg.request);
            } else {
                await piAdapter.resume(msg.request);
            }
            // Gate 3: Suppress RUN_COMPLETED if interrupted during execution.
            if (pendingInterruptRunIds.has(runId) === false) {
                await sendToMaster(createRunCompletedMessage(runId));
            }
        } finally {
            unsubscribe();
        }
    } catch (err) {
        // Gate 4: Suppress RUN_FAILED if failure was due to interruption abort.
        if (pendingInterruptRunIds.has(runId)) {
            console.error(`[Worker PID ${process.pid}] ${isStart ? "Interrupted run" : "Interrupted resume"} aborted (suppressing error):`, err);
        } else {
            console.error(`[Worker PID ${process.pid}] ${isStart ? "Run" : "Resume"} failed:`, err);
            await sendToMaster(createRunFailedMessage(runId, err));
        }
    } finally {
        activeRunId = null;
        currentPiAdapter = null;
        setTimeout(() => process.exit(0), 10);
    }
}

async function handleMasterMessage(msg: MasterToWorkerMessage): Promise<void> {
    switch (msg.type) {
        case "START_RUN":
        case "RESUME_RUN": {
            await executeRunMessage(msg);
            break;
        }

        case "INTERRUPT_RUN": {
            const interruptMode = faultInjection?.onInterruptRun(msg) ?? "normal";
            if (interruptMode === "ignore") {
                break;
            }

            pendingInterruptRunIds.add(msg.runId);
            if (msg.reason) {
                pendingInterruptReasons.set(msg.runId, msg.reason);
            }

            if (currentPiAdapter && activeRunId === msg.runId) {
                try {
                    await currentPiAdapter.interrupt(msg.runId);
                } catch (err) {
                    console.error(`[Worker PID ${process.pid}] Interrupt failed:`, err);
                }
                await notifyInterrupted(msg.runId, msg.reason);
            } else if (activeRunId === msg.runId) {
                // activeRunId 匹配但 PiAdapter 尚未就绪（setupRuntime 中或 hang 模拟）。
                await notifyInterrupted(msg.runId, msg.reason);
                if (interruptMode === "exit") {
                    setTimeout(() => process.exit(0), 10);
                }
            } else {
                // activeRunId 为空或尚未设置（INTERRUPT_RUN 先于 START_RUN 到达）。
                console.error(`[Worker PID ${process.pid}] Early INTERRUPT_RUN for ${msg.runId} buffered (activeRunId is ${activeRunId})`);
                await notifyInterrupted(msg.runId, msg.reason);
                setTimeout(() => {
                    if (activeRunId === null) {
                        process.exit(0);
                    }
                }, 3000);
            }
            break;
        }

        case "SHUTDOWN": {
            process.exit(0);
        }

        case "TOOL_PREPARE_RESPONSE":
        case "TOOL_COMPLETE_RESPONSE": {
            toolGateway.handleMasterMessage(msg);
            break;
        }
    }
}

// 6. Stdin Listener using JsonLineParser
const parser = new JsonLineParser<MasterToWorkerMessage>();

process.stdin.on("data", (chunk: Buffer | string) => {
    for (const msg of parser.feed(chunk)) {
        handleMasterMessage(msg).catch((err) => {
            console.error(`[Worker PID ${process.pid}] Error handling master message:`, err);
        });
    }
});

process.stdin.on("end", () => {
    // Master 断连时 fail-closed：拒绝所有在途工具裁决，不放过任何未受治执行。
    toolGateway.failAllPending("Master IPC 已关闭，工具治理裁决不可用");
    for (const msg of parser.flush()) {
        handleMasterMessage(msg).catch((err) => {
            console.error(`[Worker PID ${process.pid}] Error handling flushed master message:`, err);
        });
    }
});

// 7. Announce ready to Master
void sendToMaster(createWorkerReadyMessage(process.pid));

/**
 * D9：Worker 故障注入——独立模块，仅在 HARNESS_WORKER_SIMULATE 显式设置时
 * 由 worker-main.ts 动态 import 加载。默认生产路径不包含任何注入逻辑。
 *
 * 模式一览：
 * - corrupt_stdout     启动即向 stdout 写一行非 JSON（验证 Master 的脏输入韧性）
 * - crash_exit         START_RUN 时以 exit 42 异常退出
 * - crash_sigkill      START_RUN 时对自己发 SIGKILL
 * - fail_run           START_RUN 时回报 RUN_FAILED
 * - hang / hang_stubborn  收到 START_RUN 后不回应（验证 Master 中断与看门狗）
 * - tool_roundtrip     经真实 IPC 网关完成一次受治工具调用后正常退出
 * - tool_after_prepare 同上，但在 PREPARED 与 COMPLETE 之间 SIGKILL 自身，
 *                      验证 Master 侧 PREPARED 记账触发 fail-closed 恢复
 * - mock_stream        不启动 Pi，直接回放一段 text_delta 流（无 Pi 环境的演示/测试）
 */
import {
    createRunCompletedMessage,
    createRunFailedMessage,
    createRuntimeEventMessage,
    type MasterToWorkerMessage,
    type WorkerToMasterMessage,
} from "./worker-protocol.ts";
import type { WorkerToolGateway } from "./worker-tool-gateway.ts";

export interface WorkerFaultInjectionContext {
    sendToMaster(msg: WorkerToMasterMessage): Promise<void>;
    toolGateway: WorkerToolGateway;
    pendingInterruptRunIds: Set<string>;
    pendingInterruptReasons: Map<string, string>;
    notifyInterrupted(runId: string, reason?: string): Promise<void>;
}

export interface WorkerFaultInjection {
    /** 处理 START_RUN 注入分支；返回 true 表示已消费，调用方直接 return。 */
    onStartRun(msg: MasterToWorkerMessage): Promise<boolean>;
}

export function installWorkerFaultInjection(
    simulateMode: string,
    context: WorkerFaultInjectionContext,
): WorkerFaultInjection {
    const { sendToMaster, toolGateway, pendingInterruptRunIds, pendingInterruptReasons, notifyInterrupted } = context;

    if (simulateMode === "corrupt_stdout") {
        process.stdout.write("NON_JSON_CORRUPT_STDIO_LINE_FOR_RESILIENCE_TESTING\n");
    }

    return {
        async onStartRun(msg: MasterToWorkerMessage): Promise<boolean> {
            if (msg.type !== "START_RUN") {
                return false;
            }

            if (simulateMode === "crash_exit") {
                console.error(`[Worker PID ${process.pid}] Simulating abnormal exit 42`);
                process.exit(42);
            }
            if (simulateMode === "crash_sigkill") {
                console.error(`[Worker PID ${process.pid}] Simulating SIGKILL`);
                process.kill(process.pid, "SIGKILL");
                return true;
            }
            if (simulateMode === "fail_run") {
                console.error(`[Worker PID ${process.pid}] Simulating run failure`);
                await sendToMaster(createRunFailedMessage(msg.runId, new Error("Simulated worker execution failure")));
                setTimeout(() => process.exit(0), 10);
                return true;
            }
            if (simulateMode === "hang") {
                console.error(`[Worker PID ${process.pid}] Simulating hang`);
                return true;
            }
            if (simulateMode === "hang_stubborn") {
                console.error(`[Worker PID ${process.pid}] Simulating stubborn hang`);
                return true;
            }
            if (simulateMode === "tool_roundtrip" || simulateMode === "tool_after_prepare") {
                // 治理链路演练：经真实 IPC 网关完成一次受治工具调用。
                // tool_after_prepare 在 Master 写下 PREPARED 之后、COMPLETE 之前
                // SIGKILL 自身，用于验证 Master 侧 PREPARED 记账触发 fail-closed 恢复。
                await sendToMaster(createRuntimeEventMessage(msg.runId, {
                    type: "agent_started",
                    runId: msg.runId,
                    timestamp: new Date().toISOString(),
                    runtimeSessionRef: "simulate-governed-session-ref",
                }));
                try {
                    const result = await toolGateway.execute(
                        {
                            runId: msg.runId,
                            toolCallId: "simulate-governed-tool-call-1",
                            toolName: "write",
                            arguments: { path: "governed.txt" },
                            effect: "UNKNOWN_EFFECT",
                            runtimeSessionRef: "simulate-governed-session-ref",
                            lastEventSequence: 0,
                        },
                        async () => {
                            if (simulateMode === "tool_after_prepare") {
                                console.error(`[Worker PID ${process.pid}] Simulating crash between PREPARED and COMPLETE`);
                                process.kill(process.pid, "SIGKILL");
                            }
                            return { content: [{ type: "text", text: "governed tool result" }] };
                        },
                    );
                    await sendToMaster(createRuntimeEventMessage(msg.runId, {
                        type: "agent_completed",
                        runId: msg.runId,
                        timestamp: new Date().toISOString(),
                    }));
                    await sendToMaster(createRunCompletedMessage(msg.runId, "governed tool run done"));
                    void result;
                    setTimeout(() => process.exit(0), 10);
                } catch (err) {
                    await sendToMaster(createRunFailedMessage(msg.runId, err));
                    setTimeout(() => process.exit(0), 10);
                }
                return true;
            }
            if (simulateMode === "mock_stream") {
                if (pendingInterruptRunIds.has(msg.runId)) {
                    await notifyInterrupted(msg.runId, pendingInterruptReasons.get(msg.runId) ?? "Interrupted before mock stream");
                    setTimeout(() => process.exit(0), 10);
                    return true;
                }
                await sendToMaster(createRuntimeEventMessage(msg.runId, {
                    type: "agent_started",
                    runId: msg.runId,
                    timestamp: new Date().toISOString(),
                    runtimeSessionRef: "mock-session-ref",
                }));
                await sendToMaster(createRuntimeEventMessage(msg.runId, {
                    type: "text_delta",
                    runId: msg.runId,
                    timestamp: new Date().toISOString(),
                    delta: "Hello from isolated worker subprocess!",
                }));
                await sendToMaster(createRuntimeEventMessage(msg.runId, {
                    type: "agent_completed",
                    runId: msg.runId,
                    timestamp: new Date().toISOString(),
                }));
                await sendToMaster(createRunCompletedMessage(msg.runId, "Done!"));
                setTimeout(() => process.exit(0), 10);
                return true;
            }

            return false;
        },
    };
}

/**
 * Harness 已确认可以用于恢复的一条持久化边界。
 *
 * Checkpoint 不是 JavaScript 内存 dump。它只保存恢复所需的稳定引用：
 * - Pi 的持久化 Session 在哪里；
 * - Harness 已处理到哪个事件序号；
 * - 哪次工具执行的结果已经被确认保存。
 */
export interface Checkpoint {
    id: string;
    runId: string;
    toolExecutionId: string;
    runtimeSessionRef: string;
    lastEventSequence: number;
    createdAt: string;
}

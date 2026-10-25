/**
 * 排队等待估算：用"最近窗口内的完成速率"把队列位置换算成时间。
 *
 * 刻意保持极简：不建预测模型、不按用户/任务类型分层，只用
 * `position / (completedInWindow / windowMs)`。速率不足时返回 null，
 * 让上层显示"未知"而不是编一个数。
 */
export function estimateWaitMs(
    position: number,
    completedInWindow: number,
    windowMs: number,
): number | null {
    if (position <= 0 || windowMs <= 0 || completedInWindow <= 0) {
        return null;
    }

    const runsPerMs = completedInWindow / windowMs;
    return Math.round(position / runsPerMs);
}

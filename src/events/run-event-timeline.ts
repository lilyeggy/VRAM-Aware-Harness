import type { RunEvent } from "../runs/agent-run.ts";

/**
 * 把 RunEvent 格式化成适合日志和 CLI 展示的稳定时间线。
 *
 * 使用 sequence 排序，而不是依赖调用方传入顺序或 timestamp。
 * payload 可能包含大型工具结果，因此这里只打印事件边界元数据。
 */
export function formatRunEventTimeline(
    events: readonly RunEvent[],
): string {
    return [...events]
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => {
            const dedupePart = event.dedupeKey === undefined
                ? ""
                : ` dedupe=${event.dedupeKey}`;

            return [
                String(event.sequence).padStart(4, "0"),
                event.timestamp,
                event.type,
            ].join(" ")
                + dedupePart;
        })
        .join("\n");
}

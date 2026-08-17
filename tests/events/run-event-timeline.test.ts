import { expect, test } from "bun:test";

import { formatRunEventTimeline } from "../../src/events/run-event-timeline.ts";
import type { RunEvent } from "../../src/runs/agent-run.ts";

test("时间线按 sequence 排序并显示持久事件边界", () => {
    const events: RunEvent[] = [
        {
            eventId: "event-2",
            runId: "run-1",
            sequence: 2,
            type: "TOOL_STARTED",
            timestamp: "2026-07-26T10:01:00.000Z",
            payloadVersion: 1,
            payload: {},
            dedupeKey: "tool:call-1:started",
        },
        {
            eventId: "event-1",
            runId: "run-1",
            sequence: 1,
            type: "RUN_CREATED",
            timestamp: "2026-07-26T10:00:00.000Z",
            payloadVersion: 1,
            payload: {},
        },
    ];

    expect(formatRunEventTimeline(events)).toBe([
        "0001 2026-07-26T10:00:00.000Z RUN_CREATED",
        "0002 2026-07-26T10:01:00.000Z TOOL_STARTED"
            + " dedupe=tool:call-1:started",
    ].join("\n"));

    // 格式化不能改变调用方持有的原数组顺序。
    expect(events.map((event) => event.eventId)).toEqual([
        "event-2",
        "event-1",
    ]);
});

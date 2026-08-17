const baseUrl = (
    process.env.HARNESS_BASE_URL
    ?? "http://127.0.0.1:3000"
).replace(/\/$/, "");
const timeoutMs = positiveInteger(
    process.env.HARNESS_SMOKE_TIMEOUT_MS,
    120_000,
);
const pollIntervalMs = positiveInteger(
    process.env.HARNESS_SMOKE_POLL_INTERVAL_MS,
    500,
);

const healthResponse = await fetch(`${baseUrl}/health`);

if (!healthResponse.ok) {
    throw new Error(`Harness health 失败：HTTP ${healthResponse.status}`);
}

const health = await healthResponse.json() as {
    ok:boolean;
    started:boolean;
};

if (!health.ok || !health.started) {
    throw new Error("Harness 尚未启动完成");
}

const submittedAt = Date.now();
const submitResponse = await fetch(`${baseUrl}/runs`, {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body:JSON.stringify({
        tenantId:process.env.HARNESS_SMOKE_TENANT_ID
            ?? "smoke-tenant",
        sessionId:`smoke-${crypto.randomUUID()}`,
        userInput:process.env.HARNESS_SMOKE_USER_INPUT
            ?? "请使用 read 工具读取 README.md，并只回答第一行。",
        workspacePath:process.env.HARNESS_SMOKE_WORKSPACE_PATH
            ?? process.cwd(),
    }),
});

if (!submitResponse.ok) {
    throw new Error(
        `提交 Run 失败：HTTP ${submitResponse.status} ${await submitResponse.text()}`,
    );
}

const submitted = await submitResponse.json() as {
    run:{ id:string; status:string };
};
const deadline = submittedAt + timeoutMs;
let runPayload:{
    run:{ id:string; status:string };
    decisions:Array<{
        action:string;
        reasonCode:string;
        pressure:string;
    }>;
};

while (true) {
    const response = await fetch(
        `${baseUrl}/runs/${encodeURIComponent(submitted.run.id)}`,
    );

    if (!response.ok) {
        throw new Error(`查询 Run 失败：HTTP ${response.status}`);
    }

    runPayload = await response.json() as typeof runPayload;

    if (
        runPayload.run.status === "COMPLETED"
        || runPayload.run.status === "FAILED"
        || runPayload.run.status === "INTERRUPTED"
    ) {
        break;
    }

    if (Date.now() >= deadline) {
        throw new Error(
            `等待 Run 超时：${submitted.run.id} status=${runPayload.run.status}`,
        );
    }

    await Bun.sleep(pollIntervalMs);
}

const eventsResponse = await fetch(
    `${baseUrl}/runs/${encodeURIComponent(submitted.run.id)}/events`,
);

if (!eventsResponse.ok) {
    throw new Error(`查询事件失败：HTTP ${eventsResponse.status}`);
}

const eventsPayload = await eventsResponse.json() as {
    events:Array<{
        sequence:number;
        timestamp:string;
        type:string;
    }>;
};

console.log(JSON.stringify({
    runId:submitted.run.id,
    status:runPayload.run.status,
    elapsedMs:Date.now() - submittedAt,
    decisions:runPayload.decisions,
    timeline:eventsPayload.events.map((event) => ({
        sequence:event.sequence,
        timestamp:event.timestamp,
        type:event.type,
    })),
}, null, 2));

if (runPayload.run.status !== "COMPLETED") {
    process.exitCode = 1;
}

function positiveInteger(
    rawValue:string | undefined,
    defaultValue:number,
):number {
    if (rawValue === undefined) {
        return defaultValue;
    }

    const value = Number(rawValue);

    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`必须是正整数：${rawValue}`);
    }

    return value;
}

export {};

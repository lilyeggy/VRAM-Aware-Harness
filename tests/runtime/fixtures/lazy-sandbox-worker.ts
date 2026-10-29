import { JsonLineParser, formatJsonLine } from "../../../src/worker/worker-protocol.ts";
const send = (message: unknown) => process.stdout.write(formatJsonLine(message));
const parser = new JsonLineParser<any>();
let runId = "";
let remaining = 0;
const done = () => {
    send({ type: "RUNTIME_EVENT", runId, event: { type: "agent_completed", runId, timestamp: new Date().toISOString() } });
    send({ type: "RUN_COMPLETED", runId });
    setTimeout(() => process.exit(0), 10);
};
process.stdin.on("data", (chunk) => {
    for (const msg of parser.feed(chunk)) {
        if (msg.type === "START_RUN") {
            runId = msg.runId;
            send({ type: "RUNTIME_EVENT", runId, event: { type: "agent_started", runId, timestamp: new Date().toISOString(), runtimeSessionRef: `session-${runId}` } });
            if (msg.request.input === "chat") done();
            else {
                remaining = 2;
                send({ type: "SANDBOX_ACQUIRE_REQUEST", runId, requestId: 1 });
                send({ type: "SANDBOX_ACQUIRE_REQUEST", runId, requestId: 2 });
            }
        } else if (msg.type === "SANDBOX_ACQUIRE_RESPONSE") {
            if (!msg.result.ok) { send({ type: "RUN_FAILED", runId, error: msg.result.error }); setTimeout(() => process.exit(1), 10); }
            else if (--remaining === 0) done();
        }
    }
});
send({ type: "WORKER_READY", pid: process.pid });

import { test, expect } from 'bun:test';
import { ContainerWarmPool } from '../../src/sandbox/container-warm-pool.ts';

test('warm resource is exclusive, key scoped, and never returned after claim', async () => {
    const calls: readonly string[][] = [];
    const commands = { async run(args: readonly string[]) {
        (calls as string[][]).push([...args]);
        return { exitCode: 0, stdout: args[1] === 'inspect' ? 'true' : '', stderr: '' };
    } };
    const pool = new ContainerWarmPool(commands, 'docker', 1);
    await Promise.all([pool.warm('tenant-a/workspace', ['run', '--name', 'x']), pool.warm('tenant-a/workspace', ['run', '--name', 'x'])]);
    expect(calls.filter(c => c[1] === 'run')).toHaveLength(1);
    expect(await pool.take('tenant-b/workspace', 'b')).toBe(false);
    const claims = await Promise.all([pool.take('tenant-a/workspace', 'a1'), pool.take('tenant-a/workspace', 'a2')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await pool.take('tenant-a/workspace', 'a3')).toBe(false);
    await pool.close();
});

test('expired or stopped resources cannot be leased', async () => {
    const calls: string[][] = [];
    const pool = new ContainerWarmPool({ async run(args) {
        calls.push([...args]); return { exitCode: 0, stdout: args[1] === 'inspect' ? 'false' : '', stderr: '' };
    } }, 'docker', 1);
    await pool.warm('a', ['run', '--name', 'x']);
    expect(await pool.take('a', 'a1')).toBe(false);
    expect(calls.some(c => c[1] === 'rm')).toBe(true);
    await pool.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('连续补充却无人取用达到阈值后停止补充，取用请求会重置止损', async () => {
    const calls: string[][] = [];
    const pool = new ContainerWarmPool({ async run(args) {
        calls.push([...args]);
        // 探活返回 true，初始化列遗留容器返回空
        return { exitCode: 0, stdout: args.includes('{{.State.Running}}') ? 'true' : '', stderr: '' };
    } }, 'docker', 5, 10, 'owner', 2);
    const created = () => calls.filter(c => c[1] === 'run').length;

    // 阈值 2：补两次都过期后，第三次起不再补（避免低频负载白付创建成本）
    for (let round = 0; round < 4; round += 1) {
        await pool.warm('k', ['run', '--name', 'x']);
        await sleep(30);
    }
    expect(created()).toBe(2);

    // 取用请求本身就是需求证据：止损清零，补充重新被允许
    expect(await pool.take('k', 't')).toBe(false);
    await pool.warm('k', ['run', '--name', 'x']);
    expect(created()).toBe(3);
    await pool.close();
});

test('默认 TTL 足够长，短间隔的连续使用不会被过期打断', async () => {
    const calls: string[][] = [];
    const pool = new ContainerWarmPool({ async run(args) {
        calls.push([...args]);
        return { exitCode: 0, stdout: args.includes('{{.State.Running}}') ? 'true' : '', stderr: '' };
    } }, 'docker', 2);
    await pool.warm('k', ['run', '--name', 'x']);
    // 固定 60 秒的旧默认值会让这段等待直接落空；新默认是 5 分钟。
    await sleep(120);
    expect(await pool.take('k', 'leased')).toBe(true);
    await pool.close();
});

test('容量满时淘汰最旧的备用容器，新 key 仍能补货（避免旧 key 永久占位）', async () => {
    const calls: string[][] = [];
    const pool = new ContainerWarmPool({ async run(args) {
        calls.push([...args]);
        return { exitCode: 0, stdout: args.includes('{{.State.Running}}') ? 'true' : '', stderr: '' };
    } }, 'docker', 2);
    await pool.warm('key-a', ['run', '--name', 'x']);
    await pool.warm('key-b', ['run', '--name', 'x']);
    expect(calls.filter(c => c[1] === 'rm')).toHaveLength(0);

    // 池已满：第三个 key 应当挤掉最旧的那个并成功补货，
    // 而不是被静默放弃（真机表现：新工作区永远零命中）。
    await pool.warm('key-c', ['run', '--name', 'x']);
    expect(calls.filter(c => c[1] === 'rm')).toHaveLength(1);
    expect(await pool.take('key-c', 'leased')).toBe(true);
    // 被淘汰的旧 key 不再可用
    expect(await pool.take('key-a', 'stale')).toBe(false);
    await pool.close();
});

test('并发补货不会让备用容器总数超出容量，腾不出位置时放弃本次补货', async () => {
    const calls: string[][] = [];
    let created = 0;
    const pool = new ContainerWarmPool({ async run(args) {
        calls.push([...args]);
        if (args[1] === 'run') created += 1;
        return { exitCode: 0, stdout: args.includes('{{.State.Running}}') ? 'true' : '', stderr: '' };
    } }, 'docker', 2);

    // 四个不同 key 同时补货，容量只有 2：前两个占满在途名额，后两个应被放弃，
    // 而不是把总数顶到 4。
    await Promise.all([
        pool.warm('k1', ['run', '--name', 'x']),
        pool.warm('k2', ['run', '--name', 'x']),
        pool.warm('k3', ['run', '--name', 'x']),
        pool.warm('k4', ['run', '--name', 'x']),
    ]);
    expect(created).toBe(2);

    const leased: string[] = [];
    for (const key of ['k1', 'k2', 'k3', 'k4']) {
        if (await pool.take(key, `target-${key}`)) leased.push(key);
    }
    expect(leased).toEqual(['k1', 'k2']);
    await pool.close();
});

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

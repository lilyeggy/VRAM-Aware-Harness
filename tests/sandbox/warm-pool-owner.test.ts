import { test, expect } from 'bun:test';
import {
    ContainerWarmPool,
    deriveWarmPoolOwner,
} from '../../src/sandbox/container-warm-pool.ts';

test('N29：owner 由部署身份导出，跨重启稳定且标签安全', () => {
    const db = '/home/f630/cxr/harness-deploy/runtime/harness.sqlite';
    // 同一部署身份永远得到同一个 owner —— 这正是"改了端口重启也能清掉遗留容器"的前提。
    expect(deriveWarmPoolOwner(db)).toBe(deriveWarmPoolOwner(db));
    // 不同部署必须先隔开，否则会误删同机其它实例正在用的预热容器。
    expect(deriveWarmPoolOwner(db))
        .not.toBe(deriveWarmPoolOwner('/srv/other/runtime/harness.sqlite'));
    // docker 标签过滤值里不能出现 / 这类字符。
    expect(deriveWarmPoolOwner(db)).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(deriveWarmPoolOwner('   ')).toBe('default');
});

test('N29：超长部署身份截断后仍可分辨', () => {
    const long = 'a'.repeat(300);
    const first = deriveWarmPoolOwner(`/srv/${long}/runtime/harness.sqlite`);
    const second = deriveWarmPoolOwner(`/srv/${long}/runtime/harness2.sqlite`);
    expect(first.length).toBeLessThanOrEqual(120);
    expect(first).not.toBe(second);
});

test('N29：清场按本部署 owner 过滤，且只跑一次', async () => {
    const calls: string[][] = [];
    const pool = new ContainerWarmPool({ async run(args) {
        calls.push([...args]);
        // 模拟上个进程留下的两个预热容器。
        if (args[1] === 'ps') {
            return {
                exitCode: 0,
                stdout: 'agent-harness-warm-aa\nagent-harness-warm-bb\n',
                stderr: '',
            };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    } }, 'docker', 2, 300_000, 'dep-a');

    await pool.initialize();
    await pool.initialize();

    const psCalls = calls.filter((call) => call[1] === 'ps');
    expect(psCalls).toHaveLength(1);
    expect(psCalls[0]).toContain('label=agent-harness.warm-owner=dep-a');
    expect(calls.filter((call) => call[1] === 'rm')).toHaveLength(2);
    await pool.close();
});

test('N29：清场遇到不符命名契约的容器直接抛错，不顺手删掉', async () => {
    const calls: string[][] = [];
    const pool = new ContainerWarmPool({ async run(args) {
        calls.push([...args]);
        if (args[1] === 'ps') {
            return { exitCode: 0, stdout: 'agent-harness-not-a-warm-name\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    } }, 'docker', 2, 300_000, 'dep-a');

    await expect(pool.initialize()).rejects.toThrow('Unexpected warm container name');
    // 命名本身就是职责边界：改过名的容器归启动对账那条路径管，不能在这里删。
    expect(calls.filter((call) => call[1] === 'rm')).toHaveLength(0);
});

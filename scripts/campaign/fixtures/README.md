# campaign 固定夹具脚本（P0 阻塞项：固定 Workspace 快照）

对应 `docs/scenario-campaign-split-plan.zh-CN.md` §6.2 与
`docs/full-scenario-test-guide.zh-CN.md` §3.4 / §6.1。

远端快照根目录（数据盘，勿用根盘）：`/home/f630/homePLUS/harness-fixtures`

## 脚本

| 文件 | 作用 |
| --- | --- |
| `build_fixtures.py` | 生成全部夹具快照 + `manifests/*.sha256` + `SNAPSHOT.json` + `SPECIAL.json` |
| `verify_snapshot.py` | 从快照实际 `copytree` 一份，逐文件复核 SHA-256 / 权限 / 链接，输出 `VERIFY_OK\|VERIFY_FAIL` |
| `acceptance_t3_t8.py` | 在已就绪的 Harness 实例上跑 T3（result.json 精确匹配）与 T8 5x10s（阶段号完整无重复、无后台残留） |

## 用法

```sh
# 1) 生成（覆盖需 --force；--skip-big 只跳过 1000/10000 目录，便于本地冒烟）
python3 build_fixtures.py --root /home/f630/homePLUS/harness-fixtures --force

# 2) 可复现性验证
python3 verify_snapshot.py --root /home/f630/homePLUS/harness-fixtures

# 3) 临时实例验收（示例：端口 13016 的 managed-local 实例）
HARNESS_BASE_URL=http://127.0.0.1:13016 \
HARNESS_WORKSPACE_ROOT=<实例目录>/runtime/workspaces \
FIXTURE_ROOT=/home/f630/homePLUS/harness-fixtures \
EVID_DIR=/home/f630/homePLUS/harness-fixtures/verification/acceptance \
SCENARIO_EMAIL=t3t8-accept@test.local SCENARIO_PASSWORD='<本轮临时口令>' \
python3 acceptance_t3_t8.py
```

## 夹具与场景映射

| 夹具 | 支撑 | 要点 |
| --- | --- | --- |
| `base-project/` | T1/T2/T3/T4/T6/T7 | 21 个离线文件；`calc.add` 明确缺陷（减法）；公开 `test_calc.py` + 保留 `tests/test_reserved.py`；`orders.json`；`output/` |
| `big-dir/` | S10/S12 | `n1000/`(1000) `n10000/`(10000)；`boundary/` 1MiB / 2MiB / 2MiB+1 / 8MiB；`ignored-demo/`（node_modules/.git/.DS_Store）；符号链接 |
| `fault-project/` | T10/C05 | 必失败测试、可修复失败测试、只读文件(0444)、`exit 7`、可控等待脚本 |
| `slow-job/` | T8/R01/R07 | POSIX sh，alpine 3.20 可跑；`--stages × --stage-wait`；每阶段独立进度文件；前台 sleep 无后台残留 |
| `isolation/` | S05/S07 | A/B 各自唯一随机哨兵 + 宿主 HOST 哨兵 + 注入样本；无真实用户数据 |

## 口径

- 夹具在任务执行前由测试管理员投放，**准备耗时不计入任务延迟**。
- 大目录仅用于快照/Artifact 边界场景，不要复制进只剩 ~66G 的根盘实例目录。
- `slow-job` 60x60s 档需要把执行超时提到 ≥75min；默认 30min 跑不过。

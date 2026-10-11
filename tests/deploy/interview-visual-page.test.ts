import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync("docs/interview-architecture-visual.zh-CN.html", "utf8");
const bang = String.fromCharCode(33);

describe("面试用动态架构页 · ④ 虚拟机技术专区", () => {
  test("包含 ④ 专区与 9 个主题", () => {
    expect(html).toContain("④ 虚拟机技术（Docker 视角）");
    for (const id of ["compare", "lifecycle", "jailer", "snaptrap", "disks", "vsock", "toolrun", "recycle", "glossary"]) {
      expect(html).toContain("id:'" + id + "'");
    }
  });

  test("覆盖虚拟机层关键概念与真机数字", () => {
    for (const key of [
      "Firecracker", "jailer", "virtio-vsock", "/snapshot/load", "/snapshot/create",
      "templateHash", "rootfs.ext4", "workspace.ext4", "SO_PEERCRED", "reflink",
      "1477 ms", "513 ms", "2866 ms", "11.6 ms"
    ]) {
      expect(html).toContain(key);
    }
  });

  test("每个主题都有图（除名词速查表用表格）与 Docker 类比", () => {
    const topics = html.match(/^\{id:'/gm) ?? [];
    expect(topics.length).toBe(9);
    const specs = html.match(/spec:\{bands:/g) ?? [];
    expect(specs.length).toBe(8);
    const analog = html.match(/analog:'/g) ?? [];
    expect(analog.length).toBe(9);
  });

  test("页面除 DOCTYPE 外不含字面感叹号（补丁命令里出现它会挂起）", () => {
    expect(html.split(bang).length - 1).toBe(1);
  });
});

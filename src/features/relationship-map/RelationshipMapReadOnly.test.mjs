import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RelationshipMapApp, readOnlyGraphState } from "./RelationshipMapApp.jsx";
import { DetailPanel } from "./components/DetailPanel.jsx";

const memberGraph = {
  schemaVersion: "1.0",
  title: "已合作客户脉络图",
  generatedAt: "2026-09-26T08:00:00.000Z",
  colorSemantics: { yellow: "核心客户", blue: "普通客户", pink: "重点关注", green: "新客户" },
  people: [
    { id: "self", name: "你", level: "self", avatar: null },
    { id: "wang", name: "王总", level: "core", colorKey: "pink", phone: "13800000000", avatar: null },
  ],
  connections: [{ source: "self", target: "wang", relationship: "客户引荐", strength: 0.7 }],
};

function render(props) {
  return renderToString(
    createElement(RelationshipMapApp, { themeStorageKey: "test.theme", ...props }),
  );
}

describe("relationship map read-only viewer (boss)", () => {
  it("normalizes a synced snapshot through the strict graph parser", () => {
    const state = readOnlyGraphState(memberGraph);
    expect(state.readOnlyError).toBeNull();
    expect(state.storage).toBeNull();
    expect(state.graph.people.map((person) => person.name)).toEqual(["你", "王总"]);
    expect(state.graph.connections).toHaveLength(1);

    const broken = readOnlyGraphState({ schemaVersion: "1.0", people: [], connections: [] });
    expect(broken.readOnlyError).toBeTruthy();
    expect(broken.graph.people).toHaveLength(1);
  });

  it("renders without any editing, import, export or vault controls", () => {
    const html = render({ readOnlyGraph: memberGraph, readOnlyNote: "同步于 今天 16:00" });
    expect(html).toContain("只读查看");
    expect(html).toContain("1 位客户 · 只读查看");
    expect(html).toContain("同步于 今天 16:00");
    expect(html).toContain("is-read-only");
    expect(html).toContain("只读客户脉络图");
    for (const forbidden of ["新增客户", "导入 JSON", "导出关系数据", "在此新增客户", "正在载入加密客户脉络图", "本机安全存储服务", 'type="file"']) {
      expect(html).not.toContain(forbidden);
    }
    // Cosmetic, local-only controls stay available.
    expect(html).toContain("隐私模式");
  });

  it("explains an unreadable snapshot instead of offering a vault retry", () => {
    const html = render({ readOnlyGraph: { schemaVersion: "9.9" } });
    expect(html).toContain("无法显示这份客户脉络图");
    expect(html).not.toContain("重新尝试");
    expect(html).not.toContain("无法打开加密客户脉络图");
  });

  it("keeps the member editor unchanged and shows the boss transparency note", () => {
    const loading = render({ secureStorage: { open: () => new Promise(() => {}) } });
    expect(loading).toContain("正在载入加密客户脉络图");

    const editor = render({
      allowLocalStorage: true,
      storageKey: "test.graph",
      bossSyncStatus: { tone: "ok", text: "客户脉络图会同步给老板查看 · 已同步 16:00" },
    });
    expect(editor).toContain("新增客户");
    expect(editor).toContain("导入 JSON");
    expect(editor).toContain("客户脉络图会同步给老板查看 · 已同步 16:00");
    expect(editor).toContain("boss-sync-note--ok");
    expect(editor).not.toContain("只读查看");
  });

  it("shows customer details read-only", () => {
    const person = readOnlyGraphState(memberGraph).graph.people[1];
    const props = {
      person,
      privacy: false,
      visualName: "王总",
      relations: [],
      colorSemantics: memberGraph.colorSemantics,
      onChangeIdentityColor: () => {},
      onAddRelation: () => {},
      onEditRelation: () => {},
      onDeleteRelation: () => {},
      onEditPerson: () => {},
      onDeletePerson: () => {},
      onClose: () => {},
    };
    const readOnly = renderToString(createElement(DetailPanel, { ...props, readOnly: true }));
    expect(readOnly).toContain("重点关注");
    expect(readOnly).toContain("13800000000");
    expect(readOnly).toContain("暂无相关连接。");
    for (const forbidden of ["编辑客户", "删除客户", "<select", "新增", "编辑关系", "删除关系"]) {
      expect(readOnly).not.toContain(forbidden);
    }

    const editable = renderToString(createElement(DetailPanel, props));
    expect(editable).toContain("编辑客户");
    expect(editable).toContain("<select");
    expect(editable).toContain("可从这里新增");
  });
});

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { gsap } from "gsap";
import { Shirt } from "lucide-react";
import {
  ArrowsIn,
  ArrowsOut,
  DownloadSimple,
  FileText,
  FolderOpen,
  Graph,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  X,
} from "@phosphor-icons/react";
import { ConfirmDialog } from "./components/ConfirmDialog.jsx";
import { DetailPanel } from "./components/DetailPanel.jsx";
import { PersonNode } from "./components/PersonNode.jsx";
import { PersonModal } from "./components/PersonModal.jsx";
import { RelationModal } from "./components/RelationModal.jsx";
import { ReportModal } from "./components/ReportModal.jsx";
import {
  createEdges,
  createNodes,
  connections as demoConnections,
  displayName,
  expandedPositionFromLayout,
  levelOptions,
  people as demoPeople,
  positionFor,
  relationshipLegend,
} from "./data/graphData.js";
import {
  loadGraph,
  parseGraphFromStorage,
  saveGraph,
  serializeGraphForStorage,
} from "./data/graphStorage.js";
import { parseGraphDocument, serializeGraphDocument } from "./data/importGraph.js";
import { buildPersonRecord, planPersonDeletion } from "./data/personModel.js";
import {
  createPrivacySafeGraph,
  createPrivacySafeReportSummary,
  relationshipReportTitle,
} from "./data/privacyExport.js";
import { connectionRecord, connectionsForPerson } from "./data/relationshipModel.js";
import { focusPlanForNode } from "./data/graphInteraction.js";

const nodeTypes = { person: PersonNode };
const MAX_GRAPH_BYTES = 25 * 1024 * 1024;
const DEFAULT_GRAPH_TITLE = "Murmur 本地关系分析";

function isVisibleAtLevel(personLevel, filter) {
  if (filter === "all" || personLevel === "self") return true;
  return personLevel === filter;
}

function normalizeSearch(value) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function initialGraphState(storageKey, allowLocalStorage) {
  const fallback = {
    title: DEFAULT_GRAPH_TITLE,
    people: demoPeople,
    connections: demoConnections,
  };
  if (!allowLocalStorage) {
    return { graph: fallback, storage: null, storageError: null, restored: false };
  }
  let storage = null;
  try {
    storage = window.localStorage;
  } catch {
    return { graph: fallback, storage: null, storageError: "当前环境无法使用本地自动保存。", restored: false };
  }

  const loaded = loadGraph(storage, storageKey);
  if (loaded.ok && loaded.found) return { graph: loaded.graph, storage, storageError: null, restored: true };
  if (!loaded.ok) return { graph: fallback, storage, storageError: loaded.error, restored: false };
  return { graph: fallback, storage, storageError: null, restored: false };
}

function peopleWithExpandedPositions(peopleList) {
  return peopleList.map((person) => ({
    ...person,
    position: positionFor(person.id, "expanded", peopleList),
  }));
}

function readVisualTheme(storageKey) {
  try {
    return window.localStorage.getItem(storageKey) === "original"
      ? "original"
      : "tongpin";
  } catch {
    return "tongpin";
  }
}

export function RelationshipMapApp({
  allowLocalStorage = false,
  secureStorage = null,
  storageKey,
  themeStorageKey,
}) {
  const initialState = useMemo(
    () => initialGraphState(storageKey, allowLocalStorage),
    [allowLocalStorage, storageKey],
  );
  const initialGraph = initialState.graph;
  const [visualTheme, setVisualTheme] = useState(() => readVisualTheme(themeStorageKey));
  const [graphPeople, setGraphPeople] = useState(initialGraph.people);
  const [graphConnections, setGraphConnections] = useState(initialGraph.connections);
  const [graphTitle, setGraphTitle] = useState(initialGraph.title);
  const [nodes, setNodes, onNodesChange] = useNodesState(() => createNodes("expanded", initialGraph.people));
  const [edges, setEdges] = useEdgesState(() => createEdges(initialGraph.connections, initialGraph.people, "expanded"));
  const [flowInstance, setFlowInstance] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [levelFilter, setLevelFilter] = useState("all");
  const [layout, setLayout] = useState("expanded");
  const [search, setSearch] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [relationEditor, setRelationEditor] = useState(null);
  const [pendingDeleteIndex, setPendingDeleteIndex] = useState(null);
  const [personEditor, setPersonEditor] = useState(null);
  const [pendingPersonDeleteId, setPendingPersonDeleteId] = useState(null);
  const [importNotice, setImportNotice] = useState(null);
  const [storageStatus, setStorageStatus] = useState(
    secureStorage
      ? "正在载入本机数据"
      : initialState.storage
        ? (initialState.restored ? "已恢复本地数据" : "自动保存已开启")
        : "请手动导出保存",
  );
  const [storageReady, setStorageReady] = useState(!secureStorage);
  const [mutationRevision, setMutationRevision] = useState(0);
  const appRootRef = useRef(null);
  const fileInputRef = useRef(null);
  const modalReturnFocusRef = useRef(null);
  const lastStorageErrorRef = useRef(null);
  const persistGraphRef = useRef(() => {});
  const secureScopeTokenRef = useRef(null);
  const secureBaseRevisionRef = useRef(0);
  const latestMutationRevisionRef = useRef(0);
  const lastSavedMutationRevisionRef = useRef(0);
  const preparedSnapshotRef = useRef(null);
  const persistPromisesRef = useRef(new Map());
  const persistTailRef = useRef(Promise.resolve(true));
  const secureOpenPromiseRef = useRef(null);

  const activeElementWithinApp = useCallback(() => {
    const root = appRootRef.current?.getRootNode();
    const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    return active instanceof HTMLElement ? active : null;
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(themeStorageKey, visualTheme);
    } catch {
      // Theme selection is cosmetic; storage failures must not block the graph.
    }
  }, [themeStorageKey, visualTheme]);

  const openQuickDetails = useCallback((personId) => {
    setSelectedId(personId);
    setDetailOpen(true);
  }, []);

  const openQuickRelation = useCallback((personId) => {
    modalReturnFocusRef.current = activeElementWithinApp();
    setRelationEditor({ mode: "create", initialSource: personId || "self" });
  }, [activeElementWithinApp]);

  const markGraphChanged = useCallback(() => {
    setStorageStatus("待保存到本机");
    setMutationRevision((current) => current + 1);
  }, []);

  const selectedPerson = useMemo(
    () => graphPeople.find((person) => person.id === selectedId) ?? null,
    [graphPeople, selectedId],
  );

  const relationPeople = useMemo(
    () => graphPeople.map((person, index) => ({
      ...person,
      visualName: displayName(person, privacy, index),
    })),
    [graphPeople, privacy],
  );

  const selectedRelations = useMemo(() => {
    if (!selectedPerson) return [];
    const peopleById = new Map(relationPeople.map((person) => [person.id, person]));
    return connectionsForPerson(graphConnections, selectedPerson.id).map((relation) => {
      const otherId = relation.source === selectedPerson.id ? relation.target : relation.source;
      const otherPerson = peopleById.get(otherId);
      return {
        ...relation,
        otherVisualName: otherPerson?.visualName || "未知人物",
      };
    });
  }, [graphConnections, relationPeople, selectedPerson]);

  const query = normalizeSearch(search);
  const searchMatches = useMemo(() => {
    if (!query) return new Set();
    return new Set(
      graphPeople
        .filter((person) => `${person.name}${person.alias}${person.community}${person.tags.join("")}`.toLocaleLowerCase("zh-CN").includes(query))
        .map((person) => person.id),
    );
  }, [graphPeople, query]);

  const visibleNodeIds = useMemo(() => {
    return new Set(
      graphPeople
        .filter((person) => isVisibleAtLevel(person.level, levelFilter))
        .map((person) => person.id),
    );
  }, [graphPeople, levelFilter]);

  const visibleSearchMatches = useMemo(
    () => new Set([...searchMatches].filter((personId) => visibleNodeIds.has(personId))),
    [searchMatches, visibleNodeIds],
  );

  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => {
        const personIndex = graphPeople.findIndex((person) => person.id === node.id);
        const visualName = displayName(node.data, privacy, personIndex);
        const isMatch = query ? visibleSearchMatches.has(node.id) : false;

        return {
          ...node,
          hidden: !visibleNodeIds.has(node.id),
          data: {
            ...node.data,
            id: node.id,
            privacy,
            visualName,
            isMatch,
            isMuted: Boolean(query && !isMatch),
            quickCardOpen: selectedId === node.id && !detailOpen,
            quickCardSide: "right",
            relationCount: connectionsForPerson(graphConnections, node.id).length,
            onOpenDetails: openQuickDetails,
            onAddRelation: openQuickRelation,
          },
        };
      }),
    [detailOpen, graphConnections, graphPeople, nodes, openQuickDetails, openQuickRelation, privacy, query, selectedId, visibleNodeIds, visibleSearchMatches],
  );

  const renderedEdges = useMemo(
    () =>
      edges.map((edge) => {
        const hidden = !visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target);
        const searchRelevant = !query || visibleSearchMatches.has(edge.source) || visibleSearchMatches.has(edge.target);
        const selectedRelevant = Boolean(selectedId && (edge.source === selectedId || edge.target === selectedId));
        const isCrossLink = edge.data?.kind === "cross";
        let opacity = edge.data?.baseOpacity ?? edge.style.opacity;

        if (isCrossLink) opacity = selectedRelevant ? 0.88 : 0;
        else if (selectedId) opacity = selectedRelevant ? 0.98 : 0.2;
        if (!searchRelevant) opacity *= 0.16;

        return {
          ...edge,
          hidden,
          style: {
            ...edge.style,
            opacity,
            strokeWidth: (edge.data?.baseWidth ?? edge.style.strokeWidth) + (selectedRelevant ? 0.35 : 0),
          },
        };
      }),
    [edges, query, selectedId, visibleNodeIds, visibleSearchMatches],
  );

  const closeDetails = useCallback(() => {
    setDetailOpen(false);
    setSelectedId(null);
    setNodes((currentNodes) => currentNodes.map((node) => ({ ...node, selected: false })));
  }, [setNodes]);

  const closeDetailPanel = useCallback(() => {
    setDetailOpen(false);
    window.requestAnimationFrame(() => {
      const trigger = [...(appRootRef.current?.querySelectorAll("[data-quick-detail-for]") ?? [])]
        .find((candidate) => candidate.getAttribute("data-quick-detail-for") === selectedId);
      if (trigger instanceof HTMLElement) trigger.focus();
    });
  }, [selectedId]);

  const selectAndFocusPerson = useCallback((node) => {
    setSelectedId(node.id);
    setDetailOpen(false);
    setNodes((currentNodes) => currentNodes.map((currentNode) => ({
      ...currentNode,
      selected: currentNode.id === node.id,
    })));

    if (!flowInstance) return;
    const plan = focusPlanForNode(node, flowInstance.getZoom());
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    flowInstance.setCenter(plan.x, plan.y, { zoom: plan.zoom, duration: reduceMotion ? 0 : 520 });
  }, [flowInstance, setNodes]);

  const rememberModalTrigger = useCallback(() => {
    modalReturnFocusRef.current = activeElementWithinApp();
  }, [activeElementWithinApp]);

  const restoreModalTrigger = useCallback(() => {
    const trigger = modalReturnFocusRef.current;
    modalReturnFocusRef.current = null;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) {
        trigger.focus();
        return;
      }
      const fallback = appRootRef.current?.querySelector(
        "[data-person-focus-fallback='detail'], [data-person-focus-fallback='header'], [data-relation-focus-fallback='detail'], [data-relation-focus-fallback='header']",
      );
      if (fallback instanceof HTMLElement) fallback.focus();
    });
  }, []);

  const closeRelationEditor = useCallback(() => {
    setRelationEditor(null);
    restoreModalTrigger();
  }, [restoreModalTrigger]);

  const closeDeleteDialog = useCallback(() => {
    setPendingDeleteIndex(null);
    restoreModalTrigger();
  }, [restoreModalTrigger]);

  const closePersonEditor = useCallback(() => {
    setPersonEditor(null);
    restoreModalTrigger();
  }, [restoreModalTrigger]);

  const closePersonDeleteDialog = useCallback(() => {
    setPendingPersonDeleteId(null);
    restoreModalTrigger();
  }, [restoreModalTrigger]);

  const openCreateRelation = useCallback((sourceId) => {
    rememberModalTrigger();
    setRelationEditor({ mode: "create", initialSource: sourceId || selectedId || "self" });
  }, [rememberModalTrigger, selectedId]);

  const openEditRelation = useCallback((index) => {
    rememberModalTrigger();
    setRelationEditor({ mode: "edit", index });
  }, [rememberModalTrigger]);

  const openDeleteDialog = useCallback((index) => {
    rememberModalTrigger();
    setPendingDeleteIndex(index);
  }, [rememberModalTrigger]);

  const openCreatePerson = useCallback(() => {
    rememberModalTrigger();
    setPersonEditor({ mode: "create" });
  }, [rememberModalTrigger]);

  const openEditPerson = useCallback((personId) => {
    rememberModalTrigger();
    setPersonEditor({ mode: "edit", personId });
  }, [rememberModalTrigger]);

  const openPersonDeleteDialog = useCallback((personId) => {
    if (personId === "self") return;
    rememberModalTrigger();
    setPendingPersonDeleteId(personId);
  }, [rememberModalTrigger]);

  useEffect(() => {
    if (selectedPerson && !visibleNodeIds.has(selectedPerson.id)) closeDetails();
  }, [closeDetails, selectedPerson, visibleNodeIds]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (pendingPersonDeleteId !== null) closePersonDeleteDialog();
      else if (pendingDeleteIndex !== null) closeDeleteDialog();
      else if (personEditor) closePersonEditor();
      else if (relationEditor) closeRelationEditor();
      else if (reportOpen) setReportOpen(false);
      else if (detailOpen) closeDetailPanel();
      else closeDetails();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDeleteDialog, closeDetailPanel, closeDetails, closePersonDeleteDialog, closePersonEditor, closeRelationEditor, detailOpen, pendingDeleteIndex, pendingPersonDeleteId, personEditor, relationEditor, reportOpen]);

  const focusFirstMatch = useCallback(() => {
    if (!flowInstance || visibleSearchMatches.size === 0) return;
    const matchId = [...visibleSearchMatches][0];
    const matchingNode = renderedNodes.find((node) => node.id === matchId);
    if (!matchingNode) return;

    selectAndFocusPerson(matchingNode);
  }, [flowInstance, renderedNodes, selectAndFocusPerson, visibleSearchMatches]);

  const showImportNotice = useCallback((type, message) => {
    setImportNotice({ type, message });
    window.setTimeout(() => {
      setImportNotice((current) => current?.message === message ? null : current);
    }, 4200);
  }, []);

  useEffect(() => {
    if (initialState.storageError) showImportNotice("error", initialState.storageError);
  }, [initialState.storageError, showImportNotice]);

  useEffect(() => {
    if (!secureStorage) return undefined;
    let cancelled = false;
    setStorageReady(false);
    setStorageStatus("正在载入本机数据");

    void secureStorage.open().then((result) => {
      if (cancelled) {
        void secureStorage.release(result.scopeToken);
        return;
      }
      secureScopeTokenRef.current = result.scopeToken;
      secureBaseRevisionRef.current = result.revision;
      lastSavedMutationRevisionRef.current = 0;
      preparedSnapshotRef.current = null;
      if (result.content !== null) {
        const loaded = parseGraphFromStorage(result.content);
        if (!loaded.ok || !loaded.found) {
          throw new Error(loaded.error || "本机关系图数据无效");
        }
        setGraphPeople(loaded.graph.people);
        setGraphConnections(loaded.graph.connections);
        setGraphTitle(loaded.graph.title);
        setNodes(createNodes("expanded", loaded.graph.people));
        setEdges(createEdges(loaded.graph.connections, loaded.graph.people, "expanded"));
        setStorageStatus("已恢复加密本机数据");
      } else {
        setStorageStatus("加密自动保存已开启");
      }
      setStorageReady(true);
    }).catch((error) => {
      if (cancelled) return;
      secureScopeTokenRef.current = null;
      setStorageReady(true);
      setStorageStatus("请手动导出保存");
      showImportNotice(
        "error",
        error instanceof Error ? error.message : "无法打开本机加密关系图",
      );
    });

    return () => {
      cancelled = true;
    };
  }, [secureStorage, setEdges, setNodes, showImportNotice]);

  latestMutationRevisionRef.current = mutationRevision;

  const persistGraph = useCallback(async () => {
    if (!storageReady || mutationRevision === 0) return true;
    if (lastSavedMutationRevisionRef.current >= mutationRevision) return true;
    const existingPromise = persistPromisesRef.current.get(mutationRevision);
    if (existingPromise) return existingPromise;

    const graph = {
      title: graphTitle,
      people: peopleWithExpandedPositions(graphPeople),
      connections: graphConnections,
    };
    const runPersist = async () => {
      let result;
      if (secureStorage) {
        let prepared = preparedSnapshotRef.current;
        if (!prepared || prepared.mutationRevision !== mutationRevision) {
          const serialized = serializeGraphForStorage(graph);
          prepared = serialized.ok
            ? { ...serialized, mutationRevision }
            : serialized;
          if (serialized.ok) preparedSnapshotRef.current = prepared;
        }
        if (!prepared.ok) {
          result = prepared;
        } else {
          const revision = secureBaseRevisionRef.current + mutationRevision;
          const saveWithCurrentScope = async () => {
            const scopeToken = secureScopeTokenRef.current;
            if (!scopeToken) {
              throw new Error("关系图安全会话已失效，请重新打开此页面");
            }
            await secureStorage.save({
              scopeToken,
              content: prepared.content,
              revision,
            });
          };
          try {
            await saveWithCurrentScope();
            result = { ok: true, revision };
          } catch (firstError) {
            const firstMessage = firstError instanceof Error ? firstError.message : "";
            const canReopen = /安全会话|登录账号已变更|重新打开/.test(firstMessage);
            if (!canReopen) {
              result = { ok: false, error: firstMessage || "本机加密保存失败" };
            } else {
              secureScopeTokenRef.current = null;
              try {
                if (!secureOpenPromiseRef.current) {
                  secureOpenPromiseRef.current = secureStorage.open().finally(() => {
                    secureOpenPromiseRef.current = null;
                  });
                }
                const reopened = await secureOpenPromiseRef.current;
                const expectedRevision =
                  secureBaseRevisionRef.current + lastSavedMutationRevisionRef.current;
                if (reopened.revision !== expectedRevision) {
                  await secureStorage.release(reopened.scopeToken);
                  throw new Error("关系图已有更新，请重新打开页面后继续编辑");
                }
                secureScopeTokenRef.current = reopened.scopeToken;
                await saveWithCurrentScope();
                result = { ok: true, revision };
              } catch (retryError) {
                result = {
                  ok: false,
                  error: retryError instanceof Error
                    ? retryError.message
                    : "本机加密保存失败",
                };
              }
            }
          }
        }
      } else if (initialState.storage) {
        result = saveGraph(initialState.storage, graph, storageKey);
      } else {
        return true;
      }

      if (result.ok) {
        lastSavedMutationRevisionRef.current = Math.max(
          lastSavedMutationRevisionRef.current,
          mutationRevision,
        );
        lastStorageErrorRef.current = null;
        if (latestMutationRevisionRef.current === mutationRevision) {
          setStorageStatus(secureStorage ? "已加密保存到本机" : "已保存到本机");
        }
        return true;
      }
      setStorageStatus(secureStorage ? "加密保存失败" : "本地保存失败");
      if (lastStorageErrorRef.current !== result.error) {
        lastStorageErrorRef.current = result.error;
        showImportNotice("error", result.error);
      }
      return false;
    };

    const operation = persistTailRef.current
      .catch(() => false)
      .then(runPersist);
    persistTailRef.current = operation;

    persistPromisesRef.current.set(mutationRevision, operation);
    try {
      return await operation;
    } finally {
      if (persistPromisesRef.current.get(mutationRevision) === operation) {
        persistPromisesRef.current.delete(mutationRevision);
      }
    }
  }, [graphConnections, graphPeople, graphTitle, initialState.storage, mutationRevision, secureStorage, showImportNotice, storageKey, storageReady]);

  persistGraphRef.current = persistGraph;

  useEffect(() => {
    const flush = () => void persistGraphRef.current();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      void (async () => {
        await persistGraphRef.current();
        const scopeToken = secureScopeTokenRef.current;
        secureScopeTokenRef.current = null;
        if (secureStorage && scopeToken) {
          await secureStorage.release(scopeToken);
        }
      })();
    };
  }, [secureStorage]);

  useEffect(() => {
    if (!secureStorage?.onFlushRequest) return undefined;
    return secureStorage.onFlushRequest(async () => persistGraphRef.current());
  }, [secureStorage]);

  useEffect(() => {
    if (!storageReady || mutationRevision === 0) return undefined;
    const timeout = window.setTimeout(() => void persistGraphRef.current(), 600);
    return () => window.clearTimeout(timeout);
  }, [mutationRevision, storageReady]);

  const applyGraphDocument = useCallback((document, sourceName = "本地 JSON") => {
    setGraphPeople(document.people);
    setGraphConnections(document.connections);
    setGraphTitle(document.title);
    setNodes(createNodes("expanded", document.people));
    setEdges(createEdges(document.connections, document.people, "expanded"));
    setSelectedId(null);
    setDetailOpen(false);
    setLevelFilter("all");
    setSearch("");
    setLayout("expanded");
    setReportOpen(false);
    setRelationEditor(null);
    setPendingDeleteIndex(null);
    setPersonEditor(null);
    setPendingPersonDeleteId(null);
    markGraphChanged();
    showImportNotice("success", `已载入 ${document.people.length} 个人物 · ${sourceName}`);
    window.setTimeout(() => {
      flowInstance?.fitView({ padding: 0.16, duration: 680, includeHiddenNodes: false });
    }, 120);
  }, [flowInstance, markGraphChanged, setEdges, setNodes, showImportNotice]);

  const importGraphContent = useCallback((content, sourceName) => {
    try {
      applyGraphDocument(parseGraphDocument(content), sourceName);
    } catch (error) {
      showImportNotice("error", error instanceof Error ? error.message : "导入失败");
    }
  }, [applyGraphDocument, showImportNotice]);

  const openImportDialog = useCallback(async () => {
    if (window.murmurDesktop?.openGraph) {
      try {
        const result = await window.murmurDesktop.openGraph();
        if (result) importGraphContent(result.content, result.name);
      } catch (error) {
        showImportNotice("error", error instanceof Error ? error.message : "无法读取文件");
      }
      return;
    }
    fileInputRef.current?.click();
  }, [importGraphContent, showImportNotice]);

  const saveJson = useCallback(async (defaultName, content) => {
    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    if (blob.size > MAX_GRAPH_BYTES) throw new Error("导出文件不能超过 25 MB");
    if (window.murmurDesktop?.saveGraph) {
      const result = await window.murmurDesktop.saveGraph({ defaultName, content });
      if (result) showImportNotice("success", `已保存 ${result.name}`);
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = defaultName;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    window.setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(url);
    }, 1000);
    showImportNotice("success", `已导出 ${defaultName}`);
  }, [showImportNotice]);

  const exportGraphData = useCallback(async () => {
    try {
      const graph = {
        title: graphTitle,
        people: peopleWithExpandedPositions(graphPeople),
        connections: graphConnections,
      };
      const exportedGraph = privacy ? createPrivacySafeGraph(graph) : graph;
      await saveJson(
        privacy ? "murmur-relationship-map-private.json" : "murmur-relationship-map.json",
        serializeGraphDocument(exportedGraph),
      );
    } catch (error) {
      showImportNotice("error", error instanceof Error ? error.message : "导出失败");
    }
  }, [graphConnections, graphPeople, graphTitle, privacy, saveJson, showImportNotice]);

  const exportReport = useCallback(async () => {
    const corePeople = graphPeople.filter((person) => person.level === "core");
    const mostActive = [...graphPeople].filter((person) => person.id !== "self")
      .sort((a, b) => b.interactions - a.interactions)[0];
    const report = {
      title: relationshipReportTitle(graphTitle, privacy),
      generatedAt: new Date().toISOString(),
      summary: privacy
        ? createPrivacySafeReportSummary()
        : {
            people: graphPeople.length,
            connections: graphConnections.length,
            corePeople: corePeople.length,
            mostActive: mostActive
              ? { id: mostActive.id, name: mostActive.name, interactions: mostActive.interactions }
              : null,
          },
      privacyMode: privacy,
      note: "报告由本地演示规则生成，不包含聊天正文。",
    };
    try {
      await saveJson("murmur-relationship-report.json", JSON.stringify(report, null, 2));
      setReportOpen(false);
    } catch (error) {
      showImportNotice("error", error instanceof Error ? error.message : "报告导出失败");
    }
  }, [graphConnections.length, graphPeople, graphTitle, privacy, saveJson, showImportNotice]);

  const switchLayout = useCallback(() => {
    const nextLayout = layout === "expanded" ? "compact" : "expanded";
    // React Flow owns the outer node transform for x/y positioning. Animating
    // that same element lets GSAP restore a stale translate after a layout
    // switch, so the feedback animation stays on the inner visual surface.
    gsap.to(appRootRef.current?.querySelectorAll(".person-node") ?? [], {
      scale: 0.94,
      duration: 0.13,
      stagger: 0.008,
      yoyo: true,
      repeat: 1,
      ease: "power2.inOut",
    });

    setNodes((currentNodes) =>
      currentNodes.map((node) => ({
        ...node,
        position: positionFor(node.id, nextLayout, graphPeople),
      })),
    );
    setEdges(createEdges(graphConnections, graphPeople, nextLayout));
    setLayout(nextLayout);

    window.setTimeout(() => {
      flowInstance?.fitView({ padding: 0.16, duration: 680, includeHiddenNodes: false });
    }, 90);
  }, [flowInstance, graphConnections, graphPeople, layout, setEdges, setNodes]);

  const refreshEdgeHandles = useCallback((_, movedNode) => {
    const positionOverrides = new Map(nodes.map((node) => [node.id, node.position]));
    positionOverrides.set(movedNode.id, movedNode.position);
    setEdges(createEdges(graphConnections, graphPeople, layout, positionOverrides));
    const expandedPosition = expandedPositionFromLayout(movedNode.position, layout);
    setGraphPeople((currentPeople) => currentPeople.map((person) => person.id === movedNode.id
      ? { ...person, position: expandedPosition }
      : person));
    markGraphChanged();
  }, [graphConnections, graphPeople, layout, markGraphChanged, nodes, setEdges]);

  const saveRelation = useCallback((relation) => {
    const nextConnections = relationEditor?.mode === "edit"
      ? graphConnections.map((connection, index) => index === relationEditor.index ? relation : connection)
      : [...graphConnections, relation];
    const positionOverrides = new Map(nodes.map((node) => [node.id, node.position]));
    const nextSelectedId = relationEditor?.mode === "edit" && selectedId
      ? selectedId
      : relation.source;

    setGraphConnections(nextConnections);
    setEdges(createEdges(nextConnections, graphPeople, layout, positionOverrides));
    setSelectedId(nextSelectedId);
    setNodes((currentNodes) => currentNodes.map((node) => ({ ...node, selected: node.id === nextSelectedId })));
    setLevelFilter("all");
    setSearch("");
    setRelationEditor(null);
    markGraphChanged();
    restoreModalTrigger();
    showImportNotice("success", relationEditor?.mode === "edit" ? "关系已更新" : "关系已新增并显示在图上");
  }, [graphConnections, graphPeople, layout, markGraphChanged, nodes, relationEditor, restoreModalTrigger, selectedId, setEdges, setNodes, showImportNotice]);

  const confirmDeleteRelation = useCallback(() => {
    if (pendingDeleteIndex === null) return;
    const deleted = connectionRecord(graphConnections[pendingDeleteIndex]);
    const nextConnections = graphConnections.filter((_, index) => index !== pendingDeleteIndex);
    const positionOverrides = new Map(nodes.map((node) => [node.id, node.position]));
    setGraphConnections(nextConnections);
    setEdges(createEdges(nextConnections, graphPeople, layout, positionOverrides));
    setPendingDeleteIndex(null);
    markGraphChanged();
    restoreModalTrigger();
    showImportNotice("success", `已删除“${deleted.relationship}”关系`);
  }, [graphConnections, graphPeople, layout, markGraphChanged, nodes, pendingDeleteIndex, restoreModalTrigger, setEdges, showImportNotice]);

  const savePerson = useCallback((draft) => {
    const editingPerson = personEditor?.mode === "edit"
      ? graphPeople.find((person) => person.id === personEditor.personId) || null
      : null;
    const peopleWithCanonicalPositions = graphPeople.map((person) => ({
      ...person,
      position: positionFor(person.id, "expanded", graphPeople),
    }));
    const savedPerson = buildPersonRecord(draft, peopleWithCanonicalPositions, editingPerson);

    if (editingPerson) {
      const nextPeople = graphPeople.map((person) => person.id === savedPerson.id ? savedPerson : person);
      setGraphPeople(nextPeople);
      setNodes((currentNodes) => currentNodes.map((node) => node.id === savedPerson.id
        ? { ...node, data: { ...node.data, ...savedPerson }, selected: true }
        : { ...node, selected: false }));
      setSelectedId(savedPerson.id);
      showImportNotice("success", `已更新 ${privacy && savedPerson.id !== "self" ? "人物资料" : savedPerson.name}`);
    } else {
      const nextPeople = [...graphPeople, savedPerson];
      const newNode = createNodes(layout, nextPeople).find((node) => node.id === savedPerson.id);
      setGraphPeople(nextPeople);
      setNodes((currentNodes) => [
        ...currentNodes.map((node) => ({ ...node, selected: false })),
        ...(newNode ? [{ ...newNode, selected: true }] : []),
      ]);
      setSelectedId(savedPerson.id);
      setDetailOpen(false);
      showImportNotice("success", `已新增 ${privacy ? "人物" : savedPerson.name}`);
    }

    setLevelFilter("all");
    setSearch("");
    setPersonEditor(null);
    markGraphChanged();
    restoreModalTrigger();
  }, [graphPeople, layout, markGraphChanged, personEditor, privacy, restoreModalTrigger, setNodes, showImportNotice]);

  const confirmDeletePerson = useCallback(() => {
    if (!pendingPersonDeleteId) return;
    const deletingPerson = graphPeople.find((person) => person.id === pendingPersonDeleteId);
    const deletion = planPersonDeletion(pendingPersonDeleteId, graphPeople, graphConnections);
    const positionOverrides = new Map(
      nodes.filter((node) => node.id !== pendingPersonDeleteId).map((node) => [node.id, node.position]),
    );
    setGraphPeople(deletion.people);
    setGraphConnections(deletion.connections);
    setNodes((currentNodes) => currentNodes.filter((node) => node.id !== pendingPersonDeleteId));
    setEdges(createEdges(deletion.connections, deletion.people, layout, positionOverrides));
    setSelectedId(null);
    setDetailOpen(false);
    setPendingPersonDeleteId(null);
    markGraphChanged();
    restoreModalTrigger();
    showImportNotice(
      "success",
      `已删除 ${privacy ? "人物" : deletingPerson?.name || "人物"}，同时删除 ${deletion.deletedConnectionCount} 条相关关系`,
    );
  }, [graphConnections, graphPeople, layout, markGraphChanged, nodes, pendingPersonDeleteId, privacy, restoreModalTrigger, setEdges, setNodes, showImportNotice]);

  const editingConnection = relationEditor?.mode === "edit"
    ? graphConnections[relationEditor.index]
    : null;
  const pendingDeleteRelation = pendingDeleteIndex === null
    ? null
    : connectionRecord(graphConnections[pendingDeleteIndex]);
  const pendingDeleteSource = pendingDeleteRelation
    ? relationPeople.find((person) => person.id === pendingDeleteRelation.source)
    : null;
  const pendingDeleteTarget = pendingDeleteRelation
    ? relationPeople.find((person) => person.id === pendingDeleteRelation.target)
    : null;
  const editingPerson = personEditor?.mode === "edit"
    ? graphPeople.find((person) => person.id === personEditor.personId) || null
    : null;
  const pendingPersonDelete = pendingPersonDeleteId
    ? graphPeople.find((person) => person.id === pendingPersonDeleteId) || null
    : null;
  const pendingPersonRelationCount = pendingPersonDelete
    ? connectionsForPerson(graphConnections, pendingPersonDelete.id).length
    : 0;

  const selectedVisualName = selectedPerson
    ? displayName(selectedPerson, privacy, graphPeople.findIndex((person) => person.id === selectedPerson.id))
    : "";

  return (
    <main
      ref={appRootRef}
      className={`app-shell relationship-theme--${visualTheme}${storageReady ? "" : " is-storage-loading"}`}
      aria-busy={!storageReady}
    >
      {!storageReady ? (
        <div className="secure-storage-loading" role="status">正在载入关系数据</div>
      ) : null}
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><Graph size={25} weight="duotone" /></span>
          <div>
            <h1>关系爆炸图</h1>
            <p title={graphTitle}>{graphTitle}</p>
          </div>
        </div>

        <form
          className="search-box"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            focusFirstMatch();
          }}
        >
          <MagnifyingGlass size={20} weight="bold" aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索姓名、圈层或标签"
            aria-label="搜索关系图"
          />
          {search ? (
            <button type="button" onClick={() => setSearch("")} aria-label="清除搜索">
              <X size={16} weight="bold" />
            </button>
          ) : null}
          {query ? <span className="search-count">{visibleSearchMatches.size} 个结果</span> : null}
        </form>

        <div className="header-actions">
          <button
            className="data-button person-add-button"
            type="button"
            onClick={openCreatePerson}
            aria-label="新增人物"
            title="新增人物"
            data-person-focus-fallback="header"
          >
            <UserPlus size={19} weight="bold" />
            <span>新增人物</span>
          </button>
          <button
            className="data-button relation-add-button"
            type="button"
            onClick={() => openCreateRelation()}
            aria-label="新增关系"
            title="新增关系"
            data-relation-focus-fallback="header"
          >
            <Plus size={19} weight="bold" />
            <span>新增关系</span>
          </button>
          <button className="data-button" type="button" onClick={openImportDialog} aria-label="导入 JSON" title="导入 JSON">
            <FolderOpen size={19} weight="duotone" />
            <span>导入 JSON</span>
          </button>
          <button className="data-button data-button--icon" type="button" onClick={exportGraphData} aria-label="导出关系数据" title="导出关系数据">
            <DownloadSimple size={19} weight="bold" />
          </button>
          <button
            className={`data-button style-button ${visualTheme === "tongpin" ? "is-active" : ""}`}
            type="button"
            onClick={() => setVisualTheme((current) => current === "tongpin" ? "original" : "tongpin")}
            aria-label={visualTheme === "tongpin" ? "切换为原版风格" : "切换为同频风格"}
            aria-pressed={visualTheme === "tongpin"}
            title={visualTheme === "tongpin" ? "当前：同频风格，点击切换原版" : "当前：原版风格，点击切换同频"}
          >
            <Shirt size={19} strokeWidth={2.35} />
            <span>{visualTheme === "tongpin" ? "同频风格" : "原版风格"}</span>
          </button>
          <button
            className={`privacy-button ${privacy ? "is-active" : ""}`}
            type="button"
            onClick={() => setPrivacy((current) => !current)}
            aria-pressed={privacy}
            aria-label={privacy ? "关闭隐私模式" : "开启隐私模式"}
            title={privacy ? "关闭隐私模式" : "开启隐私模式"}
          >
            <ShieldCheck size={19} weight={privacy ? "fill" : "duotone"} />
            <span>{privacy ? "隐私模式已开" : "隐私模式"}</span>
          </button>
          <button className="primary-button" type="button" onClick={() => setReportOpen(true)}>
            <FileText size={19} weight="bold" />生成关系报告
          </button>
        </div>
      </header>

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="application/json,.json"
        tabIndex={-1}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          if (file.size > 25 * 1024 * 1024) {
            showImportNotice("error", "文件不能超过 25 MB");
            return;
          }
          importGraphContent(await file.text(), file.name);
        }}
      />

      {importNotice ? (
        <div className={`import-notice import-notice--${importNotice.type}`} role="status" aria-live="polite">
          {importNotice.message}
        </div>
      ) : null}

      <section className="graph-workspace" aria-label="人物关系图谱">
        <ReactFlow
          nodes={renderedNodes}
          edges={renderedEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onInit={setFlowInstance}
          onNodeClick={(_, node) => selectAndFocusPerson(node)}
          onNodeDragStop={refreshEdgeHandles}
          onPaneClick={closeDetails}
          fitView
          fitViewOptions={{ padding: 0.14, minZoom: visualTheme === "tongpin" ? 0.5 : 0.68, maxZoom: 1.05 }}
          minZoom={0.32}
          maxZoom={1.8}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          aria-label="可拖拽和缩放的人物关系图"
        >
          <Background variant={BackgroundVariant.Dots} gap={28} size={1.4} color="#c9cdcf" />
          <Controls className="clay-controls" position="bottom-right" showInteractive={false} />
        </ReactFlow>

        <div className="filter-dock" role="group" aria-label="关系层级筛选">
          <div className="dock-heading">
            <SlidersHorizontal size={18} weight="bold" />
            <span>关系层级</span>
          </div>
          <div className="filter-options">
            {levelOptions.map((option) => (
              <button
                key={option.id}
                className={levelFilter === option.id ? "is-active" : ""}
                type="button"
                onClick={() => setLevelFilter(option.id)}
                aria-pressed={levelFilter === option.id}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="privacy-status" aria-live="polite">
          <span className={`status-light ${privacy ? "is-active" : ""}`} />
          <span>{privacy ? "人物身份已脱敏" : `${graphPeople.length} 人 · ${storageStatus}`}</span>
        </div>

        <div className="graph-legend" aria-label="关系类型图例">
          {relationshipLegend.map((item) => (
            <span key={item.label}>
              <i className={item.dashed ? "is-dashed" : ""} style={{ color: item.color }} />{item.label}
            </span>
          ))}
        </div>

        <button className="layout-toggle" type="button" onClick={switchLayout}>
          {layout === "expanded" ? <ArrowsIn size={20} weight="bold" /> : <ArrowsOut size={20} weight="bold" />}
          <span>{layout === "expanded" ? "收拢关系" : "爆炸展开"}</span>
        </button>

        <div className="interaction-hint">
          <Graph size={17} weight="duotone" />
          <span>拖拽节点 · 滚轮缩放 · 点击人物聚焦并打开快捷卡片</span>
        </div>

        {selectedPerson && detailOpen ? (
          <DetailPanel
            key={selectedPerson.id}
            person={selectedPerson}
            privacy={privacy}
            visualName={selectedVisualName}
            relations={selectedRelations}
            onAddRelation={openCreateRelation}
            onEditRelation={openEditRelation}
            onDeleteRelation={openDeleteDialog}
            onEditPerson={openEditPerson}
            onDeletePerson={openPersonDeleteDialog}
            onClose={closeDetailPanel}
          />
        ) : null}
      </section>

      {reportOpen ? (
        <ReportModal
          people={graphPeople}
          connections={graphConnections}
          privacy={privacy}
          onClose={() => setReportOpen(false)}
          onExport={exportReport}
        />
      ) : null}

      {relationEditor ? (
        <RelationModal
          key={relationEditor.mode === "edit" ? `edit-${relationEditor.index}` : `create-${relationEditor.initialSource}`}
          mode={relationEditor.mode}
          initialConnection={editingConnection}
          initialSource={relationEditor.initialSource}
          people={relationPeople}
          privacy={privacy}
          connections={graphConnections}
          editingIndex={relationEditor.mode === "edit" ? relationEditor.index : -1}
          onClose={closeRelationEditor}
          onSave={saveRelation}
        />
      ) : null}

      {personEditor ? (
        <PersonModal
          key={personEditor.mode === "edit" ? `edit-${personEditor.personId}` : "create-person"}
          mode={personEditor.mode}
          person={editingPerson}
          onClose={closePersonEditor}
          onSave={savePerson}
        />
      ) : null}

      {pendingDeleteRelation ? (
        <ConfirmDialog
          title="删除这条关系？"
          description={`将删除 ${pendingDeleteSource?.visualName || "未知人物"} 与 ${pendingDeleteTarget?.visualName || "未知人物"} 之间的“${pendingDeleteRelation.relationship}”关系。此操作会立即更新当前图谱。`}
          onClose={closeDeleteDialog}
          onConfirm={confirmDeleteRelation}
        />
      ) : null}

      {pendingPersonDelete ? (
        <ConfirmDialog
          title={`删除人物${privacy ? "" : `“${pendingPersonDelete.name}”`}？`}
          description={`删除人物后，将同时删除 ${pendingPersonRelationCount} 条与该人物相关的关系，并立即重算图上的主干与补充连线。`}
          onClose={closePersonDeleteDialog}
          onConfirm={confirmDeletePerson}
        />
      ) : null}
    </main>
  );
}

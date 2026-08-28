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
  DownloadSimple,
  FlowArrow,
  FolderOpen,
  Graph,
  MagnifyingGlass,
  ShieldCheck,
  TreeStructure,
  UserPlus,
  X,
} from "@phosphor-icons/react";
import { ConfirmDialog } from "./components/ConfirmDialog.jsx";
import { CustomerTreeEdge } from "./components/CustomerTreeEdge.jsx";
import { DetailPanel } from "./components/DetailPanel.jsx";
import { PersonNode } from "./components/PersonNode.jsx";
import { PersonModal } from "./components/PersonModal.jsx";
import { RelationModal } from "./components/RelationModal.jsx";
import {
  createEdges,
  createNodes,
  connections as demoConnections,
  displayName,
  people as demoPeople,
} from "./data/graphData.js";
import {
  buildCustomerHierarchy,
  hiddenDescendantCount,
  isDescendantOf,
  layoutCustomerTree,
  visibleCustomerIds,
} from "./data/customerTreeLayout.js";
import {
  CUSTOMER_COOPERATION_STATUS,
  customerIdForEdge,
  normalizeCustomerCooperationStatus,
} from "./data/customerStatus.js";
import {
  DEFAULT_IDENTITY_COLOR_SEMANTICS,
  identityColorLabel,
  migrateLegacyPersonColorKeys,
  normalizeIdentityColorKey,
  normalizeIdentityColorSemantics,
} from "./data/identityColors.js";
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
} from "./data/privacyExport.js";
import { connectionRecord, connectionsForPerson } from "./data/relationshipModel.js";
import { focusPlanForNode } from "./data/graphInteraction.js";

const nodeTypes = { person: PersonNode };
const edgeTypes = { customerTree: CustomerTreeEdge };
const MAX_GRAPH_BYTES = 25 * 1024 * 1024;
const DEFAULT_GRAPH_TITLE = "已合作客户脉络图";

function normalizeSearch(value) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function graphTopologySignature(people, connections) {
  return JSON.stringify([
    people.map((person) => person.id),
    connections.map((connection) => {
      const record = connectionRecord(connection);
      return [record.source, record.target];
    }),
  ]);
}

function hierarchyFromTopologySignature(signature) {
  const [personIds, connections] = JSON.parse(signature);
  return buildCustomerHierarchy(
    personIds.map((id) => ({ id })),
    connections,
  );
}

function expandedSetSignature(expandedIds) {
  return JSON.stringify([...expandedIds].sort());
}

function initialGraphState(storageKey, allowLocalStorage) {
  const fallback = {
    title: DEFAULT_GRAPH_TITLE,
    colorSemantics: DEFAULT_IDENTITY_COLOR_SEMANTICS,
    people: migrateLegacyPersonColorKeys(demoPeople, demoConnections),
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
    position: person.position,
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
  const [graphColorSemantics, setGraphColorSemantics] = useState(
    normalizeIdentityColorSemantics(initialGraph.colorSemantics),
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(() => createNodes("expanded", initialGraph.people));
  const [edges, setEdges] = useEdgesState(() => createEdges(initialGraph.connections, initialGraph.people, "expanded"));
  const [flowInstance, setFlowInstance] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [layout, setLayout] = useState("horizontal");
  const [expandedIds, setExpandedIds] = useState(() => new Set(["self"]));
  const [search, setSearch] = useState("");
  const [relationEditor, setRelationEditor] = useState(null);
  const [pendingDeleteIndex, setPendingDeleteIndex] = useState(null);
  const [personEditor, setPersonEditor] = useState(null);
  const [pendingPersonDeleteId, setPendingPersonDeleteId] = useState(null);
  const [pendingRelink, setPendingRelink] = useState(null);
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

  const openQuickPerson = useCallback((parentId = "self") => {
    modalReturnFocusRef.current = activeElementWithinApp();
    setPersonEditor({ mode: "create", initialParentId: parentId || "self" });
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

  const topologySignature = useMemo(
    () => graphTopologySignature(graphPeople, graphConnections),
    [graphConnections, graphPeople],
  );

  const hierarchy = useMemo(
    () => hierarchyFromTopologySignature(topologySignature),
    [topologySignature],
  );

  const expandedSignature = useMemo(
    () => expandedSetSignature(expandedIds),
    [expandedIds],
  );

  const layoutExpandedIds = useMemo(
    () => new Set(JSON.parse(expandedSignature)),
    [expandedSignature],
  );

  const treeVisibleIds = useMemo(
    () => visibleCustomerIds(hierarchy, layoutExpandedIds),
    [hierarchy, layoutExpandedIds],
  );

  const layoutPositions = useMemo(
    () => layoutCustomerTree(hierarchy, treeVisibleIds, layout),
    [hierarchy, layout, treeVisibleIds],
  );

  const toggleBranch = useCallback((personId) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }, []);

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

  const visibleNodeIds = treeVisibleIds;

  const visibleSearchMatches = useMemo(
    () => new Set([...searchMatches].filter((personId) => visibleNodeIds.has(personId))),
    [searchMatches, visibleNodeIds],
  );

  useEffect(() => {
    if (!query || searchMatches.size === 0) return;
    setExpandedIds((current) => {
      const next = new Set(current);
      let changed = false;

      for (const personId of searchMatches) {
        let ancestorId = hierarchy.parentById.get(personId);
        while (ancestorId) {
          if (!next.has(ancestorId)) {
            next.add(ancestorId);
            changed = true;
          }
          ancestorId = hierarchy.parentById.get(ancestorId);
        }
      }

      return changed ? next : current;
    });
  }, [hierarchy, query, searchMatches]);

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
            colorLabel: node.id === "self"
              ? ""
              : identityColorLabel(node.data.colorKey, graphColorSemantics),
            depth: hierarchy.depthById.get(node.id) ?? 0,
            layerLabel: node.id === "self"
              ? "客户中心"
              : `第 ${hierarchy.depthById.get(node.id) ?? 1} 层客户`,
            hasChildren: (hierarchy.childrenById.get(node.id) ?? []).length > 0,
            isExpanded: layoutExpandedIds.has(node.id),
            visibleChildCount: (hierarchy.childrenById.get(node.id) ?? [])
              .filter((childId) => treeVisibleIds.has(childId)).length,
            hiddenDescendantCount: hiddenDescendantCount(node.id, hierarchy, treeVisibleIds),
            onOpenDetails: openQuickDetails,
            onAddPerson: openQuickPerson,
            onToggleExpand: toggleBranch,
          },
        };
      }),
    [detailOpen, graphColorSemantics, graphConnections, graphPeople, hierarchy, layoutExpandedIds, nodes, openQuickDetails, openQuickPerson, privacy, query, selectedId, toggleBranch, treeVisibleIds, visibleNodeIds, visibleSearchMatches],
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

  useEffect(() => {
    const peopleById = new Map(graphPeople.map((person) => [person.id, person]));
    const nextNodes = createNodes("expanded", graphPeople).map((node) => ({
      ...node,
      position: layoutPositions.get(node.id) || node.position,
      selected: node.id === selectedId,
    }));
    const nextEdges = createEdges(
      graphConnections,
      graphPeople,
      "expanded",
      layoutPositions,
    ).map((edge, index) => {
      const kind = hierarchy.treeEdgeIndexes.has(index) ? "primary" : "cross";
      const customerId = customerIdForEdge(edge.source, edge.target, hierarchy.depthById);
      const cooperationStatus = normalizeCustomerCooperationStatus(
        peopleById.get(customerId)?.cooperationStatus,
      );
      const isPendingCustomer = cooperationStatus === CUSTOMER_COOPERATION_STATUS.PENDING;
      const isHorizontalTreeEdge = kind === "primary" && layout === "horizontal";
      const isPyramidTreeEdge = kind === "primary" && layout === "pyramid";
      return {
        ...edge,
        sourceHandle: isHorizontalTreeEdge
          ? "source-right"
          : isPyramidTreeEdge
            ? "source-bottom"
            : edge.sourceHandle,
        targetHandle: isHorizontalTreeEdge
          ? "target-left"
          : isPyramidTreeEdge
            ? "target-top"
            : edge.targetHandle,
        type: kind === "primary" ? "customerTree" : edge.type,
        style: {
          ...edge.style,
          opacity: kind === "cross" ? 0 : edge.data?.baseOpacity,
          strokeDasharray: isPendingCustomer ? "7 8" : undefined,
        },
        data: { ...edge.data, kind, layout, cooperationStatus, customerId },
      };
    });
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, [graphConnections, graphPeople, hierarchy, layout, layoutPositions, selectedId, setEdges, setNodes]);

  useEffect(() => {
    if (!flowInstance) return undefined;
    const fitTimer = window.setTimeout(() => {
      flowInstance.fitView({
        nodes: flowInstance.getNodes().filter((node) => treeVisibleIds.has(node.id)),
        padding: 0.16,
        duration: 420,
      });
    }, 40);
    return () => window.clearTimeout(fitTimer);
  }, [flowInstance, hierarchy, layoutPositions, treeVisibleIds]);

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
    const children = hierarchy.childrenById.get(node.id) ?? [];
    const shouldExpand = children.length > 0 && !expandedIds.has(node.id);
    if (shouldExpand) {
      setSelectedId(null);
      setDetailOpen(false);
      setExpandedIds((current) => new Set(current).add(node.id));
      setNodes((currentNodes) => currentNodes.map((currentNode) => ({
        ...currentNode,
        selected: false,
      })));
      window.setTimeout(() => {
        const branchNodes = [node.id, ...children]
          .map((personId) => flowInstance?.getNode(personId))
          .filter(Boolean);
        flowInstance?.fitView({ nodes: branchNodes, padding: 0.28, duration: 520 });
      }, 80);
      return;
    }
    setSelectedId(node.id);
    setDetailOpen(false);
    setNodes((currentNodes) => currentNodes.map((currentNode) => ({
      ...currentNode,
      selected: currentNode.id === node.id,
    })));

    if (!flowInstance) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => {
      const currentNode = flowInstance.getNode(node.id) || node;
      const plan = focusPlanForNode(currentNode, flowInstance.getZoom());
      flowInstance.setCenter(plan.x, plan.y, { zoom: plan.zoom, duration: reduceMotion ? 0 : 520 });
    }, 40);
  }, [expandedIds, flowInstance, hierarchy, setNodes]);

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

  const closeRelinkDialog = useCallback(() => {
    setPendingRelink(null);
  }, []);

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

  const openCreatePerson = useCallback((parentId = "self") => {
    rememberModalTrigger();
    setPersonEditor({ mode: "create", initialParentId: parentId || "self" });
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
      else if (pendingRelink !== null) closeRelinkDialog();
      else if (pendingDeleteIndex !== null) closeDeleteDialog();
      else if (personEditor) closePersonEditor();
      else if (relationEditor) closeRelationEditor();
      else if (detailOpen) closeDetailPanel();
      else closeDetails();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDeleteDialog, closeDetailPanel, closeDetails, closePersonDeleteDialog, closePersonEditor, closeRelationEditor, closeRelinkDialog, detailOpen, pendingDeleteIndex, pendingPersonDeleteId, pendingRelink, personEditor, relationEditor]);

  const focusFirstMatch = useCallback(() => {
    if (!flowInstance || searchMatches.size === 0) return;
    const matchId = [...searchMatches][0];
    const matchingNode = renderedNodes.find((node) => node.id === matchId);
    if (!matchingNode) return;

    selectAndFocusPerson(matchingNode);
  }, [flowInstance, renderedNodes, searchMatches, selectAndFocusPerson]);

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
        setGraphColorSemantics(normalizeIdentityColorSemantics(loaded.graph.colorSemantics));
        setExpandedIds(new Set(["self"]));
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
      colorSemantics: graphColorSemantics,
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
  }, [graphColorSemantics, graphConnections, graphPeople, graphTitle, initialState.storage, mutationRevision, secureStorage, showImportNotice, storageKey, storageReady]);

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
    setGraphColorSemantics(normalizeIdentityColorSemantics(document.colorSemantics));
    setExpandedIds(new Set(["self"]));
    setSelectedId(null);
    setDetailOpen(false);
    setSearch("");
    setLayout("horizontal");
    setRelationEditor(null);
    setPendingDeleteIndex(null);
    setPersonEditor(null);
    setPendingPersonDeleteId(null);
    markGraphChanged();
    showImportNotice("success", `已载入 ${Math.max(0, document.people.length - 1)} 位客户 · ${sourceName}`);
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
        colorSemantics: graphColorSemantics,
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
  }, [graphColorSemantics, graphConnections, graphPeople, graphTitle, privacy, saveJson, showImportNotice]);

  const switchLayout = useCallback((nextLayout) => {
    if (nextLayout === layout) return;
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

    setLayout(nextLayout);

    window.setTimeout(() => {
      flowInstance?.fitView({ padding: 0.16, duration: 680, includeHiddenNodes: false });
    }, 90);
  }, [flowInstance, layout]);

  const restoreAutomaticLayout = useCallback(() => {
    setNodes((currentNodes) => currentNodes.map((node) => ({
      ...node,
      position: layoutPositions.get(node.id) || node.position,
    })));
  }, [layoutPositions, setNodes]);

  const handleNodeDragStop = useCallback((_, movedNode) => {
    if (movedNode.id === "self") {
      restoreAutomaticLayout();
      return;
    }
    const candidates = nodes.filter((node) =>
      node.id !== movedNode.id
      && visibleNodeIds.has(node.id)
      && !isDescendantOf(node.id, movedNode.id, hierarchy));
    const movedCenter = { x: movedNode.position.x + 38, y: movedNode.position.y + 43 };
    const nearest = candidates
      .map((node) => ({
        node,
        distance: Math.hypot(
          movedCenter.x - (node.position.x + 38),
          movedCenter.y - (node.position.y + 43),
        ),
      }))
      .sort((first, second) => first.distance - second.distance)[0];

    restoreAutomaticLayout();
    if (!nearest || nearest.distance > 165) return;
    const previousParentId = hierarchy.parentById.get(movedNode.id) || null;
    if (previousParentId === nearest.node.id) return;

    if (!previousParentId) {
      setGraphConnections((current) => [...current, {
        source: nearest.node.id,
        target: movedNode.id,
        relationship: "客户引荐",
        strength: 0.7,
      }]);
      setExpandedIds((current) => new Set(current).add(nearest.node.id));
      markGraphChanged();
      showImportNotice("success", "客户已连接到新的脉络");
      return;
    }

    setPendingRelink({
      personId: movedNode.id,
      previousParentId,
      nextParentId: nearest.node.id,
    });
  }, [hierarchy, markGraphChanged, nodes, restoreAutomaticLayout, showImportNotice, visibleNodeIds]);

  const confirmRelink = useCallback(() => {
    if (!pendingRelink) return;
    const previousEdgeIndex = hierarchy.parentEdgeById.get(pendingRelink.personId);
    const nextConnections = graphConnections.filter((_, index) => index !== previousEdgeIndex);
    nextConnections.push({
      source: pendingRelink.nextParentId,
      target: pendingRelink.personId,
      relationship: "客户引荐",
      strength: 0.7,
    });
    setGraphConnections(nextConnections);
    setExpandedIds((current) => new Set(current).add(pendingRelink.nextParentId));
    setPendingRelink(null);
    markGraphChanged();
    showImportNotice("success", "客户脉络已调整");
  }, [graphConnections, hierarchy, markGraphChanged, pendingRelink, showImportNotice]);

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

  const changePersonIdentityColor = useCallback((personId, colorKey) => {
    if (personId === "self") return;
    const normalizedColorKey = normalizeIdentityColorKey(colorKey);
    setGraphPeople((currentPeople) => currentPeople.map((person) => person.id === personId
      ? { ...person, colorKey: normalizedColorKey }
      : person));
    setNodes((currentNodes) => currentNodes.map((node) => node.id === personId
      ? { ...node, data: { ...node.data, colorKey: normalizedColorKey } }
      : node));
    markGraphChanged();
    showImportNotice(
      "success",
      `身份颜色已设为${identityColorLabel(normalizedColorKey, graphColorSemantics)}`,
    );
  }, [graphColorSemantics, markGraphChanged, setNodes, showImportNotice]);

  const savePerson = useCallback((draft, nextColorSemantics) => {
    const editingPerson = personEditor?.mode === "edit"
      ? graphPeople.find((person) => person.id === personEditor.personId) || null
      : null;
    const peopleWithCanonicalPositions = graphPeople.map((person) => ({ ...person }));
    const savedPerson = buildPersonRecord(draft, peopleWithCanonicalPositions, editingPerson);
    setGraphColorSemantics(normalizeIdentityColorSemantics(nextColorSemantics));

    if (editingPerson) {
      const nextPeople = graphPeople.map((person) => person.id === savedPerson.id ? savedPerson : person);
      setGraphPeople(nextPeople);
      setNodes((currentNodes) => currentNodes.map((node) => node.id === savedPerson.id
        ? { ...node, data: { ...node.data, ...savedPerson }, selected: true }
        : { ...node, selected: false }));
      setSelectedId(savedPerson.id);
      showImportNotice("success", `已更新 ${privacy && savedPerson.id !== "self" ? "客户资料" : savedPerson.name}`);
    } else {
      const nextPeople = [...graphPeople, savedPerson];
      const newNode = createNodes(layout, nextPeople).find((node) => node.id === savedPerson.id);
      setGraphPeople(nextPeople);
      if (draft.parentId && graphPeople.some((person) => person.id === draft.parentId)) {
        setGraphConnections((current) => [...current, {
          source: draft.parentId,
          target: savedPerson.id,
          relationship: "客户引荐",
          strength: 0.7,
        }]);
        setExpandedIds((current) => new Set(current).add(draft.parentId));
      }
      setNodes((currentNodes) => [
        ...currentNodes.map((node) => ({ ...node, selected: false })),
        ...(newNode ? [{ ...newNode, selected: true }] : []),
      ]);
      setSelectedId(savedPerson.id);
      setDetailOpen(false);
      showImportNotice("success", `已新增 ${privacy ? "客户" : savedPerson.name}`);
    }

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
      `已删除 ${privacy ? "客户" : deletingPerson?.name || "客户"}，同时删除 ${deletion.deletedConnectionCount} 条相关连接`,
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
            <h1>客户脉络图</h1>
            <p>客户合作管理</p>
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
            placeholder="搜索客户姓名、备注或标签"
            aria-label="搜索客户脉络图"
          />
          {search ? (
            <button type="button" onClick={() => setSearch("")} aria-label="清除搜索">
              <X size={16} weight="bold" />
            </button>
          ) : null}
          {query ? <span className="search-count">{searchMatches.size} 个结果</span> : null}
        </form>

        <div className="header-actions">
          <button
            className="data-button person-add-button"
            type="button"
            onClick={() => openCreatePerson()}
            aria-label="新增客户"
            title="新增客户"
            data-person-focus-fallback="header"
          >
            <UserPlus size={19} weight="bold" />
            <span>新增客户</span>
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

      <section className="graph-workspace" aria-label="客户脉络图">
        <ReactFlow
          nodes={renderedNodes}
          edges={renderedEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onInit={setFlowInstance}
          onNodeClick={(_, node) => selectAndFocusPerson(node)}
          onNodeDragStop={handleNodeDragStop}
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
          aria-label="可展开、拖拽和缩放的客户脉络图"
        >
          <Background variant={BackgroundVariant.Dots} gap={28} size={1.4} color="#c9cdcf" />
          <Controls className="clay-controls" position="bottom-right" showInteractive={false} />
        </ReactFlow>

        <div className="privacy-status" aria-live="polite">
          <span className={`status-light ${privacy ? "is-active" : ""}`} />
          <span>{privacy ? "客户身份已脱敏" : `${graphPeople.length - 1} 位客户 · ${storageStatus}`}</span>
        </div>

        <div className="graph-legend" aria-label="客户脉络图例">
          <span><i />已合作客户</span>
          <span><i className="is-dashed" />待合作客户</span>
        </div>

        <div className="layout-toggle" role="group" aria-label="客户脉络排列方式">
          <button
            type="button"
            className={layout === "horizontal" ? "is-active" : ""}
            onClick={() => switchLayout("horizontal")}
            aria-pressed={layout === "horizontal"}
          >
            <FlowArrow size={18} weight="bold" />横向
          </button>
          <button
            type="button"
            className={layout === "pyramid" ? "is-active" : ""}
            onClick={() => switchLayout("pyramid")}
            aria-pressed={layout === "pyramid"}
          >
            <TreeStructure size={18} weight="bold" />金字塔
          </button>
        </div>

        {selectedPerson && detailOpen ? (
          <DetailPanel
            key={selectedPerson.id}
            person={selectedPerson}
            privacy={privacy}
            visualName={selectedVisualName}
            relations={selectedRelations}
            colorSemantics={graphColorSemantics}
            onChangeIdentityColor={changePersonIdentityColor}
            onAddRelation={openCreateRelation}
            onEditRelation={openEditRelation}
            onDeleteRelation={openDeleteDialog}
            onEditPerson={openEditPerson}
            onDeletePerson={openPersonDeleteDialog}
            onClose={closeDetailPanel}
          />
        ) : null}
      </section>

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
          people={relationPeople}
          initialParentId={personEditor.initialParentId || "self"}
          colorSemantics={graphColorSemantics}
          onClose={closePersonEditor}
          onSave={savePerson}
        />
      ) : null}

      {pendingDeleteRelation ? (
        <ConfirmDialog
          title="删除这条关系？"
          description={`将删除 ${pendingDeleteSource?.visualName || "未知客户"} 与 ${pendingDeleteTarget?.visualName || "未知客户"} 之间的“${pendingDeleteRelation.relationship}”连接。`}
          onClose={closeDeleteDialog}
          onConfirm={confirmDeleteRelation}
        />
      ) : null}

      {pendingPersonDelete ? (
        <ConfirmDialog
          title={`删除客户${privacy ? "" : `“${pendingPersonDelete.name}”`}？`}
          description={`删除客户后，将同时删除 ${pendingPersonRelationCount} 条相关连接。`}
          onClose={closePersonDeleteDialog}
          onConfirm={confirmDeletePerson}
        />
      ) : null}

      {pendingRelink ? (
        <ConfirmDialog
          title="调整客户脉络？"
          description={`确认将“${relationPeople.find((person) => person.id === pendingRelink.personId)?.visualName || "该客户"}”从“${relationPeople.find((person) => person.id === pendingRelink.previousParentId)?.visualName || "原客户"}”调整到“${relationPeople.find((person) => person.id === pendingRelink.nextParentId)?.visualName || "新客户"}”下？原有主连接会取消。`}
          confirmLabel="确认调整"
          destructive={false}
          onClose={closeRelinkDialog}
          onConfirm={confirmRelink}
        />
      ) : null}
    </main>
  );
}

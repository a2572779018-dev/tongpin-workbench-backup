import { connectionKey, connectionRecord } from "./relationshipModel.js";

function comparePeopleOrder(first, second, order) {
  return (order.get(first) ?? Number.MAX_SAFE_INTEGER)
    - (order.get(second) ?? Number.MAX_SAFE_INTEGER);
}

export function buildCustomerHierarchy(people = [], connections = [], rootId = "self") {
  const peopleList = Array.isArray(people) ? people : [];
  const personIds = new Set(peopleList.map((person) => person.id));
  const order = new Map(peopleList.map((person, index) => [person.id, index]));
  const adjacency = new Map(peopleList.map((person) => [person.id, []]));

  connections.forEach((connection, index) => {
    const record = connectionRecord(connection);
    if (!personIds.has(record.source) || !personIds.has(record.target)) return;
    adjacency.get(record.source).push({ id: record.target, index });
    adjacency.get(record.target).push({ id: record.source, index });
  });
  adjacency.forEach((items) => items.sort((first, second) =>
    first.index - second.index || comparePeopleOrder(first.id, second.id, order)));

  const parentById = new Map([[rootId, null]]);
  const parentEdgeById = new Map();
  const depthById = new Map([[rootId, 0]]);
  const childrenById = new Map(peopleList.map((person) => [person.id, []]));
  const queue = personIds.has(rootId) ? [rootId] : [];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentId = queue[cursor];
    for (const neighbor of adjacency.get(currentId) ?? []) {
      if (parentById.has(neighbor.id)) continue;
      parentById.set(neighbor.id, currentId);
      parentEdgeById.set(neighbor.id, neighbor.index);
      depthById.set(neighbor.id, (depthById.get(currentId) ?? 0) + 1);
      childrenById.get(currentId).push(neighbor.id);
      queue.push(neighbor.id);
    }
  }

  const disconnectedIds = peopleList
    .map((person) => person.id)
    .filter((personId) => !parentById.has(personId));
  const treeEdgeIndexes = new Set(parentEdgeById.values());

  const descendantCountById = new Map();
  const countDescendants = (personId) => {
    if (descendantCountById.has(personId)) return descendantCountById.get(personId);
    const count = (childrenById.get(personId) ?? []).reduce(
      (total, childId) => total + 1 + countDescendants(childId),
      0,
    );
    descendantCountById.set(personId, count);
    return count;
  };
  peopleList.forEach((person) => countDescendants(person.id));

  return {
    rootId,
    parentById,
    parentEdgeById,
    depthById,
    childrenById,
    descendantCountById,
    disconnectedIds,
    treeEdgeIndexes,
    edgeKeyForPerson(personId) {
      const parentId = parentById.get(personId);
      return parentId ? connectionKey(parentId, personId) : null;
    },
  };
}

export function visibleCustomerIds(hierarchy, expandedIds = new Set()) {
  const visible = new Set();
  if (!hierarchy?.rootId) return visible;
  const visit = (personId) => {
    visible.add(personId);
    if (!expandedIds.has(personId)) return;
    for (const childId of hierarchy.childrenById.get(personId) ?? []) visit(childId);
  };
  visit(hierarchy.rootId);
  hierarchy.disconnectedIds.forEach((personId) => visible.add(personId));
  return visible;
}

export function hiddenDescendantCount(personId, hierarchy, visibleIds) {
  const stack = [...(hierarchy.childrenById.get(personId) ?? [])];
  let hidden = 0;
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!visibleIds.has(currentId)) hidden += 1;
    stack.push(...(hierarchy.childrenById.get(currentId) ?? []));
  }
  return hidden;
}

function horizontalPositions(hierarchy, visibleIds) {
  const positions = new Map();
  let leafRow = 0;
  const yById = new Map();
  const visit = (personId) => {
    const visibleChildren = (hierarchy.childrenById.get(personId) ?? [])
      .filter((childId) => visibleIds.has(childId));
    if (visibleChildren.length === 0) {
      const y = 70 + leafRow * 110;
      leafRow += 1;
      yById.set(personId, y);
      return y;
    }
    const childYs = visibleChildren.map(visit);
    const y = childYs.reduce((sum, value) => sum + value, 0) / childYs.length;
    yById.set(personId, y);
    return y;
  };
  visit(hierarchy.rootId);

  visibleIds.forEach((personId) => {
    if (!hierarchy.depthById.has(personId)) return;
    positions.set(personId, {
      x: 120 + (hierarchy.depthById.get(personId) ?? 0) * 270,
      y: yById.get(personId) ?? 70,
    });
  });

  const connectedBottom = Math.max(leafRow * 110 + 70, 330);
  hierarchy.disconnectedIds.forEach((personId, index) => {
    if (!visibleIds.has(personId)) return;
    positions.set(personId, { x: 120 + index * 190, y: connectedBottom + 90 });
  });
  return positions;
}

function pyramidPositions(hierarchy, visibleIds) {
  const positions = new Map();
  const horizontalGap = 190;
  const verticalGap = 170;
  const startX = 140;
  let leafColumn = 0;
  let maxDepth = 0;

  const placeSubtree = (personId) => {
    const depth = hierarchy.depthById.get(personId) ?? 0;
    maxDepth = Math.max(maxDepth, depth);
    const visibleChildren = (hierarchy.childrenById.get(personId) ?? [])
      .filter((childId) => visibleIds.has(childId));

    let x;
    if (visibleChildren.length === 0) {
      x = startX + leafColumn * horizontalGap;
      leafColumn += 1;
    } else {
      const childXs = visibleChildren.map(placeSubtree);
      x = (childXs[0] + childXs[childXs.length - 1]) / 2;
    }

    positions.set(personId, { x, y: 80 + depth * verticalGap });
    return x;
  };

  placeSubtree(hierarchy.rootId);

  const bottom = 80 + (maxDepth + 1) * verticalGap;
  hierarchy.disconnectedIds.forEach((personId, index) => {
    if (!visibleIds.has(personId)) return;
    positions.set(personId, { x: startX + (leafColumn + index) * horizontalGap, y: bottom });
  });
  return positions;
}

export function layoutCustomerTree(hierarchy, visibleIds, mode = "horizontal") {
  return mode === "pyramid"
    ? pyramidPositions(hierarchy, visibleIds)
    : horizontalPositions(hierarchy, visibleIds);
}

export function isDescendantOf(candidateId, ancestorId, hierarchy) {
  let currentId = hierarchy.parentById.get(candidateId);
  while (currentId) {
    if (currentId === ancestorId) return true;
    currentId = hierarchy.parentById.get(currentId);
  }
  return false;
}

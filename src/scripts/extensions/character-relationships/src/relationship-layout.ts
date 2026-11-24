export const CARD_PERSON_ID = 'card';

const NODE_WIDTH = 128;
const NODE_HEIGHT = 54;
const RING_GAP = 168;
const PADDING = 24;

type Point = { x: number; y: number };

type EdgeLayout = {
    edge: TauriTavernCharacterRelationship;
    index: number;
    start: Point;
    length: number;
    angle: number;
    label: Point;
};

function placePeople(graph: TauriTavernCharacterRelationshipGraph): Map<string, Point> {
    const connections = new Map(graph.people.map(person => [person.id, new Set<string>()]));
    for (const { from, to } of graph.relationships) {
        connections.get(from)?.add(to);
        connections.get(to)?.add(from);
    }

    const distance = new Map([[CARD_PERSON_ID, 0]]);
    const queue = [CARD_PERSON_ID];
    for (const id of queue) {
        const nextDistance = (distance.get(id) ?? 0) + 1;
        for (const neighbor of connections.get(id) ?? []) {
            if (!distance.has(neighbor)) {
                distance.set(neighbor, nextDistance);
                queue.push(neighbor);
            }
        }
    }

    const outerRing = Math.max(...distance.values()) + 1;
    const rings = new Map<number, string[]>();
    for (const { id } of graph.people) {
        if (id === CARD_PERSON_ID) continue;
        const ring = distance.get(id) ?? outerRing;
        const members = rings.get(ring) ?? [];
        members.push(id);
        rings.set(ring, members);
    }

    const positions = new Map([[CARD_PERSON_ID, { x: 0, y: 0 }]]);
    let radius = 0;
    for (const [ring, members] of [...rings].sort(([a], [b]) => a - b)) {
        radius = Math.max(radius + RING_GAP, (members.length * (NODE_WIDTH + 30)) / (2 * Math.PI));
        members.forEach((id, index) => {
            const angle = (2 * Math.PI * index) / members.length - Math.PI / 4 + (ring - 1) * Math.PI / 3;
            positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
        });
    }
    return positions;
}

function placeEdges(
    graph: TauriTavernCharacterRelationshipGraph,
    positions: ReadonlyMap<string, Point>,
): EdgeLayout[] {
    const parallelEdges = new Map<string, { edge: TauriTavernCharacterRelationship; index: number; sign: number }[]>();
    graph.relationships.forEach((edge, index) => {
        const { from, to } = edge;
        const forward = from < to;
        const key = JSON.stringify(forward ? [from, to] : [to, from]);
        const group = parallelEdges.get(key) ?? [];
        group.push({ edge, index, sign: forward ? 1 : -1 });
        parallelEdges.set(key, group);
    });

    const edges: EdgeLayout[] = [];
    for (const group of parallelEdges.values()) {
        group.forEach(({ edge, index, sign }, offsetIndex) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return;

            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const distance = Math.hypot(dx, dy);
            const ux = dx / distance;
            const uy = dy / distance;
            const inset = Math.min(NODE_WIDTH / (2 * Math.abs(ux)), NODE_HEIGHT / (2 * Math.abs(uy))) + 6;
            const offset = (offsetIndex - (group.length - 1) / 2) * Math.min(28, 60 / group.length) * sign;
            const x = -uy * offset;
            const y = ux * offset;
            edges.push({
                edge,
                index,
                start: { x: from.x + x + ux * inset, y: from.y + y + uy * inset },
                angle: Math.atan2(dy, dx),
                length: Math.max(0, distance - 2 * inset),
                label: { x: (from.x + to.x) / 2 + x, y: (from.y + to.y) / 2 + y },
            });
        });
    }
    return edges;
}

export function layoutRelationships(graph: TauriTavernCharacterRelationshipGraph) {
    const centered = placePeople(graph);
    const points = [...centered.values()];
    const horizontalPadding = NODE_WIDTH / 2 + PADDING;
    const verticalPadding = NODE_HEIGHT / 2 + PADDING;
    const left = Math.min(...points.map(point => point.x)) - horizontalPadding;
    const top = Math.min(...points.map(point => point.y)) - verticalPadding;
    const right = Math.max(...points.map(point => point.x)) + horizontalPadding;
    const bottom = Math.max(...points.map(point => point.y)) + verticalPadding;
    const people = new Map([...centered].map(([id, { x, y }]) => [id, { x: x - left, y: y - top }]));
    return { people, edges: placeEdges(graph, people), width: right - left, height: bottom - top };
}

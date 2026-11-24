import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { MessageKey, Translate } from './i18n';
import { CARD_PERSON_ID, layoutRelationships } from './relationship-layout';

const fieldLabels = new Map<string, MessageKey>([
    ['description', 'description'],
    ['personality', 'personality'],
    ['scenario', 'scenario'],
    ['firstMessage', 'firstMessage'],
    ['alternateGreeting', 'alternateGreeting'],
    ['dialogueExamples', 'dialogueExamples'],
    ['creatorNotes', 'creatorNotes'],
]);

function sourceLabel(
    evidence: TauriTavernCharacterRelationship['evidence'],
    lorebookName: string | null,
    tr: Translate,
) {
    const field = fieldLabels.get(evidence.source);
    const label = evidence.source === 'lorebook' ? lorebookName ?? tr('lorebook') : field ? tr(field) : evidence.source;
    return evidence.entry ? `${label} · ${evidence.entry}` : label;
}

function centerViewport(element: HTMLDivElement | null) {
    if (element) {
        element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
        element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
    }
}

export function RelationshipMap({ graph, tr }: { graph: TauriTavernCharacterRelationshipGraph; tr: Translate }) {
    const layout = useMemo(() => layoutRelationships(graph), [graph]);
    const names = useMemo(() => new Map(graph.people.map(person => [person.id, person.name])), [graph]);
    const [fitZoom, setFitZoom] = useState(1);
    const [manualZoom, setManualZoom] = useState<number | null>(null);
    const [person, setPerson] = useState<string | null>(null);
    const [activeEdge, setActiveEdge] = useState<number | null>(null);
    const viewport = useRef<HTMLDivElement>(null);
    const evidence = useRef<HTMLElement>(null);
    const zoom = manualZoom ?? fitZoom;
    const minimumZoom = Math.min(0.4, fitZoom);

    useLayoutEffect(() => {
        const element = viewport.current;
        if (!element) return;
        const observer = new ResizeObserver(() => {
            if (element.clientWidth && element.clientHeight) {
                setFitZoom(Math.min(1, element.clientWidth / layout.width, element.clientHeight / layout.height));
            }
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [layout]);
    useLayoutEffect(() => centerViewport(viewport.current), [layout, zoom]);
    useLayoutEffect(() => {
        if (activeEdge !== null) evidence.current?.scrollIntoView({ block: 'nearest' });
    }, [activeEdge]);

    function resetView() {
        setManualZoom(null);
        centerViewport(viewport.current);
    }

    function describe(edge: TauriTavernCharacterRelationship) {
        return `${names.get(edge.from) ?? edge.from} → ${names.get(edge.to) ?? edge.to} · ${edge.label}`;
    }

    function selectPerson(id: string) {
        setPerson(person === id ? null : id);
        setActiveEdge(null);
    }

    function toggleEvidence(index: number) {
        setActiveEdge(current => current === index ? null : index);
    }

    const relevant = (edge: TauriTavernCharacterRelationship) => person === null || person === edge.from || person === edge.to;
    const visible = graph.relationships.map((edge, index) => ({ edge, index })).filter(({ edge }) => relevant(edge));

    return (
        <div className="tt-relationships-results">
            <section className="tt-relationships-map" aria-label={tr('map')}>
                <div className="tt-relationships-zoom">
                    <button className="menu_button" type="button" aria-label={tr('zoomOut')} disabled={zoom <= minimumZoom} onClick={() => setManualZoom(Math.max(minimumZoom, zoom / 1.25))}>−</button>
                    <button className="menu_button" type="button" title={tr('resetView')} aria-label={tr('resetView')} onClick={resetView}>{Math.round(zoom * 100)}%</button>
                    <button className="menu_button" type="button" aria-label={tr('zoomIn')} disabled={zoom >= 2} onClick={() => setManualZoom(Math.min(2, zoom * 1.25))}>+</button>
                </div>
                <div className="tt-relationships-viewport" ref={viewport}>
                    <div className="tt-relationships-stage">
                        <div className="tt-relationships-frame" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
                            <div className="tt-relationships-diagram" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
                                {layout.edges.map(({ edge, index, start, length, angle }) => (
                                    <span key={index} aria-hidden="true" className="tt-relationships-edge"
                                        data-muted={!relevant(edge)}
                                        data-active={activeEdge === index}
                                        style={{ left: start.x, top: start.y, width: length, transform: `rotate(${angle}rad)` }} />
                                ))}
                                {graph.people.map(({ id, name }) => {
                                    const position = layout.people.get(id);
                                    if (!position) return null;
                                    return (
                                        <button key={id} type="button" className="tt-relationships-person"
                                            data-card={id === CARD_PERSON_ID} aria-pressed={person === id} title={name}
                                            style={{ left: position.x, top: position.y }} onClick={() => selectPerson(id)}>
                                            <span>{name}</span>
                                        </button>
                                    );
                                })}
                                {layout.edges.map(({ edge, index, label }) => {
                                    if (!relevant(edge) || (visible.length > 18 && activeEdge !== index)) return null;
                                    return (
                                        <button key={index} type="button" className="tt-relationships-edge-label"
                                            aria-label={describe(edge)} title={describe(edge)} aria-pressed={activeEdge === index}
                                            style={{ left: label.x, top: label.y }} onClick={() => toggleEvidence(index)}>
                                            {edge.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            </section>
            <section className="tt-relationships-evidence" aria-label={tr('relationships')}>
                <div className="tt-relationships-evidence-heading">
                    <h3>{person ? names.get(person) : tr('relationships')}</h3>
                    {person && <button type="button" className="menu_button" onClick={() => { setPerson(null); setActiveEdge(null); }}>{tr('showAll')}</button>}
                </div>
                {!visible.length && <p>{tr('noPersonRelationships')}</p>}
                <ul>
                    {visible.map(({ edge, index }) => (
                        <li key={index}>
                            <button type="button" className="tt-relationships-list-item" aria-expanded={activeEdge === index}
                                onClick={() => toggleEvidence(index)}>
                                <strong>{names.get(edge.from)} → {names.get(edge.to)}</strong>
                                <span>{edge.label}</span>
                            </button>
                            {activeEdge === index && (
                                <figure ref={evidence}>
                                    <blockquote>{edge.evidence.quote}</blockquote>
                                    <figcaption>{sourceLabel(edge.evidence, graph.lorebookName, tr)}</figcaption>
                                </figure>
                            )}
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}

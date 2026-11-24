import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { createTranslator } from './i18n';
import { RelationshipMap } from './RelationshipMap';

type CharacterRelationshipsProps = {
    model: string;
    hasKey: boolean;
    locale: string;
    translate: (text: string, key: string) => string;
    load: () => Promise<TauriTavernCharacterRelationships>;
    generate: (includeLorebook: boolean) => Promise<TauriTavernCharacterRelationships>;
    manageKey: () => Promise<boolean>;
};

function errorText(error: unknown, fallback: string) {
    return error instanceof Error && error.message ? error.message : fallback;
}

export function CharacterRelationshipsApp(props: CharacterRelationshipsProps) {
    const { model, locale, translate, load, generate, manageKey } = props;
    const tr = createTranslator(translate);
    const [state, setState] = useState<TauriTavernCharacterRelationships | null>(null);
    const [hasKey, setHasKey] = useState(props.hasKey);
    const [includeLorebook, setIncludeLorebook] = useState(false);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [configuring, setConfiguring] = useState(false);
    const [error, setError] = useState('');
    const fallback = tr('unknownError');

    useEffect(() => {
        let active = true;
        void load().then(result => {
            if (!active) return;
            setState(result);
            setLoading(false);
        }, (error: unknown) => {
            if (!active) return;
            setError(errorText(error, fallback));
            setLoading(false);
        });
        return () => { active = false; };
    }, [load, fallback]);

    async function runAnalysis() {
        setError('');
        setGenerating(true);
        try {
            setState(await generate(includeLorebook && Boolean(state?.lorebookName)));
        } catch (error) {
            setError(errorText(error, fallback));
        } finally {
            setGenerating(false);
        }
    }

    async function configureKey() {
        setError('');
        setConfiguring(true);
        try {
            setHasKey(await manageKey());
        } catch (error) {
            setError(errorText(error, fallback));
        } finally {
            setConfiguring(false);
        }
    }

    const graph = state?.result;
    return (
        <div className="tt-relationships">
            <header>
                <h2>{tr('title')}</h2>
                {state && <p className="tt-relationships-card-name">{state.characterName}</p>}
            </header>
            <div className="tt-relationships-controls">
                <div>
                    <div className="tt-relationships-model">DeepSeek · {model}</div>
                    <p className="tt-relationships-meta">{tr('sendNote')}</p>
                    {state?.lorebookName && (
                        <label className="tt-relationships-lorebook">
                            <input type="checkbox" checked={includeLorebook} disabled={generating}
                                onChange={event => setIncludeLorebook(event.currentTarget.checked)} />
                            {tr('addLorebook')} · {state.lorebookName}
                        </label>
                    )}
                </div>
                <div className="tt-relationships-actions">
                    <button type="button" className="menu_button" disabled={configuring || generating} onClick={() => void configureKey()}>{tr('manageKey')}</button>
                    <button type="button" className="menu_button tt-relationships-generate"
                        disabled={loading || generating || configuring || !hasKey} onClick={() => void runAnalysis()}>
                        {graph ? tr('regenerate') : tr('generate')}
                    </button>
                </div>
            </div>
            {!hasKey && <p className="tt-relationships-meta">{tr('missingKey')}</p>}
            {(loading || generating) && <p className="tt-relationships-status" role="status">{loading ? tr('load') : tr('generating')}</p>}
            {error && <p className="tt-relationships-status" role="alert">{error}</p>}
            {state?.stale && <p className="tt-relationships-status">{tr('stale')}</p>}
            {graph ? (
                <>
                    <p className="tt-relationships-meta tt-relationships-result-meta">
                        <time dateTime={graph.generatedAt}>{new Date(graph.generatedAt).toLocaleString(locale)}</time>
                        {' · '}{graph.model}{' · '}{graph.lorebookName ?? tr('cardText')}
                    </p>
                    {graph.relationships.length
                        ? <RelationshipMap graph={graph} tr={tr} key={graph.generatedAt} />
                        : <p className="tt-relationships-status">{tr('noRelationships')}</p>}
                </>
            ) : !loading && !error && <p className="tt-relationships-status">{tr('noResult')}</p>}
        </div>
    );
}

export function mountCharacterRelationships(container: HTMLElement, props: CharacterRelationshipsProps) {
    const root = createRoot(container);
    root.render(<CharacterRelationshipsApp {...props} />);
    return () => root.unmount();
}

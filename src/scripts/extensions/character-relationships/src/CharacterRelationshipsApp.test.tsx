import { describe, expect, it, rs } from '@rstest/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CharacterRelationshipsApp } from './index';

describe('character relationship map', () => {
    it('opens a saved graph without a key and keeps its evidence when a new analysis fails', async () => {
        const user = userEvent.setup();
        const saved: TauriTavernCharacterRelationships = {
            characterName: 'Mira',
            lorebookName: 'Harbor',
            stale: false,
            result: {
                generatedAt: '2026-01-01T00:00:00Z',
                model: 'deepseek-flash',
                lorebookName: 'Harbor',
                people: [{ id: 'card', name: 'Mira' }, { id: 'kai', name: 'Kai' }, { id: 'sal', name: 'Sal' }],
                relationships: [{
                    from: 'kai', to: 'sal', label: 'trained',
                    evidence: { source: 'lorebook', entry: 'Apprentices', quote: 'Kai trained Sal at the harbor.' },
                }],
            },
        };
        const generate = rs.fn<(includeLorebook: boolean) => Promise<TauriTavernCharacterRelationships>>()
            .mockRejectedValue(new Error('DeepSeek rate limit reached.'));
        render(<CharacterRelationshipsApp model="deepseek-flash" hasKey={false} locale="en"
            translate={text => text} load={() => Promise.resolve(saved)} generate={generate}
            manageKey={() => Promise.resolve(true)} />);

        const regenerate = await screen.findByRole<HTMLButtonElement>('button', { name: 'Regenerate' });
        expect(regenerate.disabled).toBe(true);
        const lorebook = screen.getByRole<HTMLInputElement>('checkbox', { name: /include primary lorebook/i });
        expect(lorebook.checked).toBe(false);
        const relations = within(screen.getByRole('region', { name: 'Relationships' }));
        await user.click(relations.getByRole('button', { name: 'Kai → Sal trained' }));
        expect(relations.getByText('Kai trained Sal at the harbor.')).toBeTruthy();
        expect(relations.getByText('Harbor · Apprentices')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Manage DeepSeek API key' }));
        await user.click(lorebook);
        await user.click(regenerate);
        expect(generate).toHaveBeenCalledWith(true);
        expect((await screen.findByRole('alert')).textContent).toBe('DeepSeek rate limit reached.');
        expect(relations.getByText('Kai trained Sal at the harbor.')).toBeTruthy();
    });
});

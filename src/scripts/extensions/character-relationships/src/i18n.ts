const messages = {
    title: 'Character relationships',
    cardText: 'Character card text',
    sendNote: 'Generation sends the saved card text and selected lorebook to DeepSeek.',
    addLorebook: 'Include primary lorebook',
    manageKey: 'Manage DeepSeek API key',
    missingKey: 'Add a DeepSeek API key to generate a relationship map.',
    load: 'Loading relationship map…',
    generate: 'Generate',
    regenerate: 'Regenerate',
    generating: 'Generating with DeepSeek…',
    stale: 'The source material has changed. Regenerate to update the map.',
    noResult: 'Generate a map to see the relationships in this card.',
    noRelationships: 'No relationships with supporting text were found.',
    map: 'Relationship map',
    relationships: 'Relationships',
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    resetView: 'Reset view',
    showAll: 'Show all relationships',
    noPersonRelationships: 'No relationships are listed for this person.',
    unknownError: 'The relationship map could not be loaded or generated.',
    description: 'Character description',
    personality: 'Personality',
    scenario: 'Scenario',
    firstMessage: 'First message',
    alternateGreeting: 'Alternate greeting',
    dialogueExamples: 'Example dialogue',
    creatorNotes: 'Creator notes',
    lorebook: 'Lorebook',
} as const;

export type MessageKey = keyof typeof messages;
export type Translate = (key: MessageKey) => string;

export function createTranslator(translate: (text: string, key: string) => string): Translate {
    return key => translate(messages[key], `character_relationships.${key}`);
}

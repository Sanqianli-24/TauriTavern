use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRelationshipResult {
    pub card_created_at: String,
    pub source_fingerprint: String,
    #[serde(flatten)]
    pub graph: CharacterRelationshipGraph,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRelationshipGraph {
    pub generated_at: String,
    pub model: String,
    pub lorebook_name: Option<String>,
    pub people: Vec<CharacterRelationshipPerson>,
    pub relationships: Vec<CharacterRelationship>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CharacterRelationshipPerson {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CharacterRelationship {
    pub from: String,
    pub to: String,
    pub label: String,
    pub evidence: CharacterRelationshipEvidence,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CharacterRelationshipEvidence {
    pub source: String,
    pub entry: Option<String>,
    pub quote: String,
}

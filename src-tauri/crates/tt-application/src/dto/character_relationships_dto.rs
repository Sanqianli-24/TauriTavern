use serde::{Deserialize, Serialize};
use tt_domain::models::character_relationships::CharacterRelationshipGraph;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateCharacterRelationshipsDto {
    pub name: String,
    pub include_lorebook: bool,
    pub model: String,
    pub locale: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRelationshipsDto {
    pub character_name: String,
    pub lorebook_name: Option<String>,
    pub result: Option<CharacterRelationshipGraph>,
    pub stale: bool,
}

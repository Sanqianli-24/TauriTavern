use super::*;

#[test]
fn only_selected_story_text_can_support_a_relationship() {
    let mut character = Character::new(
        "Mira".to_string(),
        "Kai protects Mira.".to_string(),
        String::new(),
        String::new(),
    );
    character.data.system_prompt = "Unrelated prompt data".to_string();
    let mut material = AnalysisMaterial::from_character(&character);
    let card_fingerprint = material.fingerprint().unwrap();
    material
        .add_lorebook(
            "Harbor",
            &json!({ "entries": {
                "0": { "comment": "Apprentices", "content": "Kai trained\nSal at the harbor." },
                "1": { "disable": true, "content": "Unrelated disabled entry" },
            }}),
        )
        .unwrap();
    let prompt = material.to_json().unwrap();
    assert!(!prompt.contains("Unrelated"));
    assert_ne!(card_fingerprint, material.fingerprint().unwrap());

    let graph = json!({
        "people": [{"id":"card", "name":"Mira"}, {"id":"kai", "name":"Kai"}, {"id":"sal", "name":"Sal"}],
        "relationships": [{"from":"kai", "to":"sal", "label":"trained", "sourceIndex":1, "quote":"Kai trained Sal at the harbor."}]
    });
    let (_, relationships) = material.parse_graph(&graph.to_string()).unwrap();
    assert_eq!(
        relationships[0].evidence.entry.as_deref(),
        Some("Apprentices")
    );
    assert_eq!(
        (&relationships[0].from[..], &relationships[0].to[..]),
        ("kai", "sal")
    );

    let mut wrong_quote = graph.clone();
    wrong_quote["relationships"][0]["quote"] = json!("Kai is Sal's parent.");
    let mut wrong_person = graph;
    wrong_person["relationships"][0]["to"] = json!("unknown");
    for invalid in [
        "  ".to_string(),
        "{\"people\":[".to_string(),
        wrong_quote.to_string(),
        wrong_person.to_string(),
    ] {
        assert!(matches!(
            material.parse_graph(&invalid),
            Err(ApplicationError::ValidationError(_))
        ));
    }
}

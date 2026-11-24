use std::io::ErrorKind;
use std::path::PathBuf;

use tokio::fs;
use tt_contracts::client_asset_paths::validate_path_segment;
use tt_domain::errors::DomainError;

use super::FileCharacterRepository;

impl FileCharacterRepository {
    pub(super) fn relationship_path(&self, name: &str) -> Result<PathBuf, DomainError> {
        if !validate_path_segment(name) {
            return Err(DomainError::InvalidData(
                "Character storage identity is invalid".to_string(),
            ));
        }

        Ok(self
            .characters_dir
            .with_file_name("character-relationships")
            .join(format!("{name}.json")))
    }

    pub(super) async fn remove_relationships(&self, name: &str) {
        let result = async { Ok(fs::remove_file(self.relationship_path(name)?).await) }.await;
        Self::report_relationship_file_change(name, result);
    }

    pub(super) async fn move_relationships(&self, old_name: &str, new_name: &str) {
        let result = async {
            let old_path = self.relationship_path(old_name)?;
            let new_path = self.relationship_path(new_name)?;
            Ok(fs::rename(old_path, new_path).await)
        }
        .await;
        Self::report_relationship_file_change(old_name, result);
    }

    fn report_relationship_file_change(
        name: &str,
        result: Result<std::io::Result<()>, DomainError>,
    ) {
        // The character change has already been published. Report auxiliary file errors
        // without presenting the successful character operation as a failed one.
        let error = match result {
            Ok(Ok(())) => return,
            Ok(Err(error)) if error.kind() == ErrorKind::NotFound => return,
            Ok(Err(error)) => error.to_string(),
            Err(error) => error.to_string(),
        };
        tracing::error!(
            target: tt_contracts::observability::USER_VISIBLE_ERROR,
            "Could not update the relationship graph file for character '{}': {}",
            name,
            error
        );
    }
}

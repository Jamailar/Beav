use super::types::AppStore;
use crate::{SubjectCategory, SubjectRecord};

pub(crate) fn list_subjects(store: &AppStore) -> Vec<SubjectRecord> {
    store.subjects.clone()
}

pub(crate) fn get_subject(store: &AppStore, id: &str) -> Option<SubjectRecord> {
    store.subjects.iter().find(|item| item.id == id).cloned()
}

pub(crate) fn list_subject_categories(store: &AppStore) -> Vec<SubjectCategory> {
    store.categories.clone()
}

pub(crate) fn replace_catalog(
    store: &mut AppStore,
    categories: Vec<SubjectCategory>,
    subjects: Vec<SubjectRecord>,
) {
    store.categories = categories;
    store.subjects = subjects;
}

pub(crate) fn catalog_snapshot(store: &AppStore) -> (Vec<SubjectCategory>, Vec<SubjectRecord>) {
    (list_subject_categories(store), list_subjects(store))
}

pub(crate) fn search_subjects(
    store: &AppStore,
    query: &str,
    category_id: Option<&str>,
) -> Vec<SubjectRecord> {
    let query = query.trim().to_lowercase();
    store
        .subjects
        .iter()
        .filter(|subject| {
            let matches_category = match category_id {
                Some(category) => subject.category_id.as_deref() == Some(category),
                None => true,
            };
            let matches_query = if query.is_empty() {
                true
            } else {
                let haystack = format!(
                    "{}\n{}\n{}",
                    subject.name,
                    subject.description.clone().unwrap_or_default(),
                    subject.tags.join(" ")
                )
                .to_lowercase();
                haystack.contains(&query)
            };
            matches_category && matches_query
        })
        .cloned()
        .collect()
}

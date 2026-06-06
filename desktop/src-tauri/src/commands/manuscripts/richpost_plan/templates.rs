use super::*;

pub(in crate::commands::manuscripts) fn normalize_richpost_template(value: &str) -> &'static str {
    match value.trim() {
        "cover" => "cover",
        "text-image" => "text-image",
        "image-focus" => "image-focus",
        "quote" => "quote",
        "ending" => "ending",
        _ => "text-stack",
    }
}

pub(in crate::commands::manuscripts) fn richpost_master_name_from_template(
    template: &str,
) -> String {
    match normalize_richpost_template(template) {
        "cover" => RICHPOST_MASTER_COVER.to_string(),
        "ending" => RICHPOST_MASTER_ENDING.to_string(),
        _ => RICHPOST_MASTER_BODY.to_string(),
    }
}

pub(in crate::commands::manuscripts) fn richpost_master_role(
    master_name: &str,
    template: &str,
) -> &'static str {
    match sanitize_richpost_master_name(master_name).as_deref() {
        Some(RICHPOST_MASTER_COVER) => RICHPOST_MASTER_COVER,
        Some(RICHPOST_MASTER_ENDING) => RICHPOST_MASTER_ENDING,
        Some(RICHPOST_MASTER_BODY) => RICHPOST_MASTER_BODY,
        _ => match normalize_richpost_template(template) {
            "cover" => RICHPOST_MASTER_COVER,
            "ending" => RICHPOST_MASTER_ENDING,
            _ => RICHPOST_MASTER_BODY,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_richpost_template, richpost_master_name_from_template};
    use crate::commands::manuscripts::{RICHPOST_MASTER_BODY, RICHPOST_MASTER_COVER};

    #[test]
    fn template_normalization_falls_back_to_text_stack() {
        assert_eq!(normalize_richpost_template("cover"), "cover");
        assert_eq!(normalize_richpost_template("unknown"), "text-stack");
    }

    #[test]
    fn master_name_follows_template_role() {
        assert_eq!(
            richpost_master_name_from_template("cover"),
            RICHPOST_MASTER_COVER
        );
        assert_eq!(
            richpost_master_name_from_template("text-stack"),
            RICHPOST_MASTER_BODY
        );
    }
}

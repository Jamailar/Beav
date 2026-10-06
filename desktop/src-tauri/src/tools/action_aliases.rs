use serde_json::{json, Map, Value};

pub fn normalized_app_cli_action_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

pub fn canonical_app_cli_action_for_policy<'a>(action: &'a str) -> &'a str {
    match normalized_app_cli_action_key(action).as_str() {
        "pluginslist" | "pluginsconnectors" => "plugins.discover",
        "pluginsmarketplace" | "pluginscodexmarketplace" | "pluginsdiscoverlocal" => {
            "plugins.discover"
        }
        "pluginsinstallcodex" | "pluginsrequestinstall" => "plugins.install",
        "skillsinstallfromrepo"
        | "skillsinstallfromgithub"
        | "skillsuninstall"
        | "skillsdelete" => "skills.manage",
        "skillslist" | "skillsread" | "skillsget" => "skills.inspect",
        "taskbriefcontext" | "taskbriefgetcontext" | "taskbriefcompactcontext" => {
            "taskBrief.context"
        }
        "memorylist" | "memoryrecall" => "memory.search",
        "memoryadd" => "memory.note",
        "memoryupdate" | "memoryarchive" | "memoryrebuildindex" | "memorydiagnostics" => {
            "memory.manage"
        }
        "topiccenterlist" | "topiccenterget" | "topiccenterread" | "topiccentersearch" => {
            "topicCenter.read"
        }
        "topiccentercreate"
        | "topiccenteradd"
        | "topiccenterupdate"
        | "topiccenteredit"
        | "topiccenterupsert"
        | "topiccenterbulkupsert"
        | "topiccenterabandon"
        | "topiccenterarchive"
        | "topiccenterdelete"
        | "topiccenterremove" => "topicCenter.manage",
        "redclawrunnerstatus"
        | "redclawrunnerstart"
        | "redclawrunnerstop"
        | "redclawrunnersetconfig" => "runner.manage",
        "redclawprofilebundle" | "redclawprofileread" => "profile.read",
        "redclawprofileupdate" | "redclawprofilecompletestyledefinition" => "profile.manage",
        "redclawtaskpreview" | "redclawtasklist" | "redclawtaskstats" | "taskpreview"
        | "tasklist" | "taskstats" => "task.read",
        "redclawtaskcreate" | "redclawtaskconfirm" | "redclawtaskupdate" | "redclawtaskcancel"
        | "taskcreate" | "taskconfirm" | "taskupdate" | "taskcancel" => "task.manage",
        "assetcreate" | "assetscreate" | "subjectcreate" | "subjectscreate" => "assets.manage",
        "assetupdate" | "assetsupdate" | "subjectupdate" | "subjectsupdate" => "assets.manage",
        "assetdelete" | "assetsdelete" | "subjectdelete" | "subjectsdelete" => "assets.manage",
        "assetcategoriescreate"
        | "assetscategoriescreate"
        | "subjectcategoriescreate"
        | "subjectscategoriescreate" => "assets.manage",
        "spacelist" | "spaceslist" | "spaceget" | "spacesget" | "spacecreate" | "spacescreate"
        | "spaceswitch" | "spacesswitch" | "spacerename" | "spacesrename" | "spacedelete"
        | "spacesdelete" | "spaceensure" | "spacesensure" => "spaces.manage",
        "mcplist"
        | "mcpsessions"
        | "mcpget"
        | "mcplisttools"
        | "mcptools"
        | "mcplistresources"
        | "mcplistresourcetemplates" => "mcp.inspect",
        "mcpadd" | "mcpremove" | "mcpdelete" | "mcpenable" | "mcpdisable" | "mcpdiscoverlocal"
        | "mcpimportlocal" | "mcpsave" | "mcptest" | "mcpdisconnect" | "mcpdisconnectall"
        | "mcpoauthstatus" => "mcp.manage",
        "teamsessioncreate"
        | "teammemberspawn"
        | "teammembermatch"
        | "teammemberrename"
        | "teammembershutdown"
        | "teammemberinterrupt"
        | "teammembercancel"
        | "teammemberresume"
        | "teammemberwait"
        | "teamtaskcreate"
        | "teamtaskupdate"
        | "teammessagesend"
        | "teamreportrequest"
        | "teamreportsubmit"
        | "teamartifactattach"
        | "teamblockerraise" => "team.control",
        _ => action,
    }
}

pub fn canonicalize_app_cli_arguments(arguments: &Value) -> Value {
    let Some(action) = arguments
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return arguments.clone();
    };
    let Some((canonical_action, operation)) = app_cli_action_alias(action) else {
        return arguments.clone();
    };
    let mut object = arguments.as_object().cloned().unwrap_or_default();
    object.insert("action".to_string(), json!(canonical_action));
    if let Some(operation) = operation {
        let mut payload = object
            .get("payload")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        payload
            .entry("operation".to_string())
            .or_insert_with(|| json!(operation));
        object.insert("payload".to_string(), Value::Object(payload));
    }
    ensure_compat_metadata(&mut object, action, canonical_action);
    Value::Object(object)
}

fn app_cli_action_alias(action: &str) -> Option<(&'static str, Option<&'static str>)> {
    match normalized_app_cli_action_key(action).as_str() {
        "assetcreate" | "assetscreate" | "subjectcreate" | "subjectscreate" => {
            Some(("assets.manage", Some("create")))
        }
        "assetupdate" | "assetsupdate" | "subjectupdate" | "subjectsupdate" => {
            Some(("assets.manage", Some("update")))
        }
        "assetdelete" | "assetsdelete" | "subjectdelete" | "subjectsdelete" => {
            Some(("assets.manage", Some("delete")))
        }
        "assetcategoriescreate"
        | "assetscategoriescreate"
        | "subjectcategoriescreate"
        | "subjectscategoriescreate" => Some(("assets.manage", Some("category.create"))),
        "spacelist" | "spaceslist" => Some(("spaces.manage", Some("list"))),
        "spaceget" | "spacesget" => Some(("spaces.manage", Some("get"))),
        "spacecreate" | "spacescreate" => Some(("spaces.manage", Some("create"))),
        "spaceswitch" | "spacesswitch" => Some(("spaces.manage", Some("switch"))),
        "spacerename" | "spacesrename" => Some(("spaces.manage", Some("rename"))),
        "spacedelete" | "spacesdelete" => Some(("spaces.manage", Some("delete"))),
        "spaceensure" | "spacesensure" => Some(("spaces.manage", Some("ensure"))),
        "taskpreview" => Some(("task.read", Some("preview"))),
        "tasklist" => Some(("task.read", Some("list"))),
        "taskstats" => Some(("task.read", Some("stats"))),
        "taskcreate" => Some(("task.manage", Some("create"))),
        "taskconfirm" => Some(("task.manage", Some("confirm"))),
        "taskupdate" => Some(("task.manage", Some("update"))),
        "taskcancel" => Some(("task.manage", Some("cancel"))),
        "topiccenterlist" | "topiccenterread" | "topiccentersearch" => {
            Some(("topicCenter.read", Some("list")))
        }
        "topiccenterget" => Some(("topicCenter.read", Some("get"))),
        "topiccentercreate" | "topiccenteradd" => Some(("topicCenter.manage", Some("create"))),
        "topiccenterupdate" | "topiccenteredit" => Some(("topicCenter.manage", Some("update"))),
        "topiccenterupsert" | "topiccenterbulkupsert" => {
            Some(("topicCenter.manage", Some("bulkUpsert")))
        }
        "topiccenterabandon" | "topiccenterarchive" => {
            Some(("topicCenter.manage", Some("abandon")))
        }
        "topiccenterdelete" | "topiccenterremove" => Some(("topicCenter.manage", Some("delete"))),
        _ => None,
    }
}

fn ensure_compat_metadata(object: &mut Map<String, Value>, action: &str, canonical_action: &str) {
    let mut compat = object
        .get("__compat")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    compat
        .entry("legacyToolName".to_string())
        .or_insert_with(|| json!("workflow"));
    compat
        .entry("legacyCommand".to_string())
        .or_insert_with(|| json!(action));
    compat.insert("translatedAction".to_string(), json!(canonical_action));
    object.insert("__compat".to_string(), Value::Object(compat));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_singular_asset_update_to_assets_manage() {
        let result = canonicalize_app_cli_arguments(&json!({
            "action": "asset.update",
            "payload": { "id": "asset-1", "name": "新名字" }
        }));

        assert_eq!(result.get("action"), Some(&json!("assets.manage")));
        assert_eq!(result.pointer("/payload/operation"), Some(&json!("update")));
        assert_eq!(
            result.pointer("/__compat/legacyCommand"),
            Some(&json!("asset.update"))
        );
    }

    #[test]
    fn canonicalizes_asset_category_create_to_assets_manage() {
        let result = canonicalize_app_cli_arguments(&json!({
            "action": "asset.categories.create",
            "payload": { "name": "择校&备考经验" }
        }));

        assert_eq!(result.get("action"), Some(&json!("assets.manage")));
        assert_eq!(
            result.pointer("/payload/operation"),
            Some(&json!("category.create"))
        );
    }

    #[test]
    fn canonicalizes_legacy_spaces_create_to_spaces_manage() {
        let result = canonicalize_app_cli_arguments(&json!({
            "action": "spaces.create",
            "payload": { "name": "护理考研账号" }
        }));

        assert_eq!(result.get("action"), Some(&json!("spaces.manage")));
        assert_eq!(result.pointer("/payload/operation"), Some(&json!("create")));
        assert_eq!(
            result.pointer("/__compat/legacyCommand"),
            Some(&json!("spaces.create"))
        );
    }
}

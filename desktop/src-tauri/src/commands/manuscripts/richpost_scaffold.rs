use super::*;

pub(super) fn richpost_theme_spec_storage_value(theme: &RichpostThemeSpec) -> Value {
    theme::store::richpost_theme_spec_storage_value(theme)
}

pub(super) fn richpost_theme_root_master_path_for_theme(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    master_name: &str,
) -> Option<std::path::PathBuf> {
    theme::store::richpost_theme_root_master_path_for_theme(package_path, theme, master_name)
}

pub(super) fn richpost_theme_spec_from_manifest(
    package_path: Option<&std::path::Path>,
    manifest: &Value,
) -> RichpostThemeSpec {
    theme::store::richpost_theme_spec_from_manifest(package_path, manifest)
}

pub(super) fn default_richpost_master_fragment(master_name: &str) -> &'static str {
    let _ = master_name;
    r#"<!--
RedBox richpost master scaffold.
- 保留 zone 占位符，不要把正文直接写进母版
- 背景层使用 rb-zone-background，默认位于文字下方
- 真实文字区域由 --rb-frame-left / top / width / height 控制
- 可以自由增加容器、遮罩、装饰，但不要删掉 title/body/media/footer 区
-->
<style>
.rb-page-host .rb-stage {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100%;
}
.rb-page-host .rb-zone-background,
.rb-page-host .rb-zone-overlay,
.rb-page-host .rb-zone-decoration {
  position: absolute;
  inset: 0;
}
.rb-page-host .rb-zone-background {
  background-image: var(--rb-background-image, none);
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
}
.rb-page-host .rb-zone-background .page-asset,
.rb-page-host .rb-zone-background img {
  width: 100%;
  height: 100%;
}
.rb-page-host .rb-zone-background img {
  object-fit: cover;
}
.rb-page-host .rb-stage-frame {
  position: absolute;
  left: var(--rb-frame-left, 8%);
  top: var(--rb-frame-top, 10%);
  width: var(--rb-frame-width, 84%);
  height: var(--rb-frame-height, 78%);
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: var(--rb-zone-gap);
  align-items: flex-start;
  justify-content: flex-start;
  overflow: hidden;
}
.rb-page-host .rb-zone-title,
.rb-page-host .rb-zone-body,
.rb-page-host .rb-zone-media,
.rb-page-host .rb-zone-footer {
  width: 100%;
  max-width: 100%;
}
.rb-page-host .rb-zone-media .page-asset img {
  object-fit: cover;
}
</style>
<div class="rb-stage">
  <div class="rb-zone rb-zone-background">{{zone:background}}</div>
  <div class="rb-zone rb-zone-overlay">{{zone:overlay}}</div>
  <div class="rb-zone rb-zone-decoration">{{zone:decoration}}</div>
  <div class="rb-stage-frame" data-zone-frame="content">
    <header class="rb-zone rb-zone-title">{{zone:title}}</header>
    <main class="rb-zone rb-zone-body">{{zone:body}}</main>
    <div class="rb-zone rb-zone-media">{{zone:media}}</div>
    <footer class="rb-zone rb-zone-footer">{{zone:footer}}</footer>
  </div>
</div>"#
}

pub(super) fn richpost_master_file_needs_upgrade(path: &std::path::Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return true;
    };
    !content.contains("data-zone-frame=\"content\"")
        || !content.contains("--rb-frame-left")
        || content.contains("min-height: var(--rb-frame-height")
        || !content.contains(
            ".rb-page-host .rb-stage {\n  position: relative;\n  width: 100%;\n  height: 100%;",
        )
        || content.contains("rb-stage-stack")
}

pub(super) fn ensure_richpost_layout_scaffold(
    package_path: &std::path::Path,
    manifest: &Value,
) -> Result<Value, String> {
    theme::scaffold::ensure_richpost_layout_scaffold(package_path, manifest)
}

#[allow(dead_code)]
pub(crate) fn richpost_theme_catalog_value(package_path: Option<&std::path::Path>) -> Value {
    theme::scaffold::richpost_theme_catalog_value(package_path)
}

pub(crate) fn richpost_theme_catalog_value_for_manifest(
    package_path: Option<&std::path::Path>,
    manifest: &Value,
) -> Value {
    theme::scaffold::richpost_theme_catalog_value_for_manifest(package_path, manifest)
}

pub(crate) fn richpost_theme_state_value(
    package_path: &std::path::Path,
    manifest: &Value,
) -> Value {
    theme::scaffold::richpost_theme_state_value(package_path, manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_master_fragment_contains_required_zones() {
        let fragment = default_richpost_master_fragment(RICHPOST_MASTER_BODY);
        assert!(fragment.contains("{{zone:title}}"));
        assert!(fragment.contains("data-zone-frame=\"content\""));
    }
}

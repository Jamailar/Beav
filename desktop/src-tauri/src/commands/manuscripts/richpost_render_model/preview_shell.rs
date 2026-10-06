use super::*;

pub(in crate::commands::manuscripts) fn render_richpost_preview_shell(
    title: &str,
    plan: &Value,
    tokens: &Value,
    typography: RichpostTypographySettings,
) -> String {
    let pages = plan
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let cards = pages
        .iter()
        .filter_map(|page| {
            let page_id = page.get("id").and_then(Value::as_str)?;
            let label = page.get("label").and_then(Value::as_str).unwrap_or(page_id);
            Some(format!(
                "<section class=\"preview-card\"><iframe title=\"{}\" src=\"./pages/{}.html?v={}\" loading=\"lazy\"></iframe></section>",
                escape_html(label),
                escape_html(page_id),
                now_i64()
            ))
        })
        .collect::<Vec<_>>()
        .join("");
    let shell_bg = richpost_token_value(tokens, "--rb-shell-bg");
    let preview_card_bg = richpost_token_value(tokens, "--rb-preview-card-bg");
    let preview_card_border = richpost_token_value(tokens, "--rb-preview-card-border");
    let preview_card_shadow = richpost_token_value(tokens, "--rb-preview-card-shadow");
    let text_color = richpost_token_value(tokens, "--rb-text");
    let muted_color = richpost_token_value(tokens, "--rb-muted");
    let heading_font = richpost_token_value(tokens, "--rb-heading-font");
    let body_font = richpost_token_value(tokens, "--rb-body-font");
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{}</title>
  <style>
    :root {{
      color-scheme: light;
      --bg:{};
      --card:{};
      --text:{};
      --muted:{};
      --line:{};
      --shadow:{};
      --heading-font:{};
      --body-font:{};
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin:0; background:var(--bg); color:var(--text); font-family:var(--body-font); }}
    .shell {{ max-width: 780px; margin: 0 auto; padding: 28px 18px 48px; }}
    .pages {{ display:flex; flex-direction:column; gap:20px; }}
    .preview-card {{ padding:16px; background:var(--card); border:1px solid var(--line); box-shadow:var(--shadow); backdrop-filter: blur(10px); border-radius:0; }}
    iframe {{ display:block; width:100%; aspect-ratio:3/4; border:0; background:#fff; }}
  </style>
  <script>
    (() => {{
      const params = new URLSearchParams(window.location.search);
      const defaultFontScale = String({});
      const defaultLineHeightScale = String({});
      const rawFontScale = params.get('fontScale') || defaultFontScale;
      const rawLineHeightScale = params.get('lineHeightScale') || defaultLineHeightScale;
      document.addEventListener('DOMContentLoaded', () => {{
        document.querySelectorAll('iframe').forEach((frame) => {{
          const src = frame.getAttribute('src');
          if (!src) return;
          const nextUrl = new URL(src, window.location.href);
          nextUrl.searchParams.set('fontScale', rawFontScale);
          nextUrl.searchParams.set('lineHeightScale', rawLineHeightScale);
          frame.setAttribute('src', nextUrl.toString());
        }});
      }});
    }})();
  </script>
</head>
<body>
  <div class="shell">
    <main class="pages">{}</main>
  </div>
</body>
</html>"#,
        escape_html(title),
        shell_bg,
        preview_card_bg,
        text_color,
        muted_color,
        preview_card_border,
        preview_card_shadow,
        heading_font,
        body_font,
        typography.font_scale,
        typography.line_height_scale,
        cards
    )
}

English | [简体中文](./README.md)

# Beav

Local-first AI workspace for content creators — collect sources, draft posts and edit videos.

> **Source snapshot ≠ latest desktop release:** This repository provides a Tauri + Rust 2.5.0 source snapshot and distributes continuously updated Beav desktop installers. The latest desktop releases use Tauri + Rust; their features and published source scope differ from 2.5.0. The public source is **source-available under a non-commercial license**, not standard MIT open source. See [LICENSE](./LICENSE).

![Browser extension demo: save a Xiaohongshu post and its comments to Beav](./images/plugin-save-xiaohongshu.gif)

The recording shows the Chinese interface: open a Xiaohongshu post, capture the post and comments with the browser extension, then keep them as reusable sources in Beav.

[Download](https://beav.pro/download) · [Video demo (Chinese)](https://www.bilibili.com/video/BV12LNn6nEem/) · [User guide](https://beav.pro/en/docs) · [Latest release](https://github.com/Jamailar/Beav/releases/latest)

## Three core use cases

These describe the maintained desktop product. See the source boundary below before evaluating the public code.

- **Build a source library:** collect webpages, Xiaohongshu posts and comments, then search, cite and reuse them.
- **Run a content account:** use references, topics and account plans to draft and revise posts, scripts and voice-over copy.
- **Produce images and videos:** reuse image templates, edit talking-head footage and subtitles, add supporting visuals and export a finished video.

## Public source and desktop releases

| | Public source snapshot | Maintained desktop releases |
| --- | --- | --- |
| Version and stack | Tauri + Rust 2.5.0 in the public repository's `desktop/` | Tauri + Rust; see the latest release for the current version |
| Features | The code and documentation in that historical snapshot | The 2.8 feature overview below and current user guide |
| New 2.8 implementations | Does not include the 2.8 media workshop, editing, template and daily-brief implementations or improvements described below, or the current Tauri MCP host | Distributed with the desktop product; availability depends on platform, permissions and configuration |
| License | Custom non-commercial source license; commercial use requires written permission | The application's User Agreement and applicable product/service entitlements |

The public source is not a complete or live mirror of the latest desktop product. Building the 2.5.0 snapshot will not reproduce the 2.8 installer. Public components such as the browser extension may update independently of the desktop source snapshot.

See [desktop/README.md](./desktop/README.md) for the source layout, dependencies and local build steps.

## Workflow in the desktop release

| Task | Entry point |
| --- | --- |
| Collect webpages, social posts and comments; research public sources | Chrome / Edge extension, chat, Knowledge |
| Find topics using daily briefs, trends, subscriptions and saved sources | Home: start from a topic, daily brief |
| Maintain positioning, audience, content direction and cadence | Home mini-app: Account Operations Plan |
| Draft and revise posts, scripts and voice-over copy | Chat, Manuscripts |
| Generate images from template variables and reference images | Media Workshop, image templates, Assets |
| Edit talking-head footage, subtitles, overlays and animations | Media Workshop: Smart Talking-head Editing, video editor |
| Schedule work and review results | Content Calendar, chat |

## 2.8 desktop release features

These **Tauri + Rust implementations and improvements are not included in the public Tauri + Rust 2.5.0 snapshot**. An older feature with a similar name does not imply equivalent behavior. Availability depends on the installed version, account permissions, model configuration and operating system. See the [changelog](./CHANGELOG.md) for version-specific changes.

### Media Workshop and talking-head editing

Import a recording to review suggested cuts based on word-level transcription, meaning and pauses. Apply basic edits to the timeline, revise subtitles, add picture-in-picture footage and text overlays, and compare optional voice denoising.

The separate video-editor window provides a multitrack timeline, canvas transforms, keyframes, transitions, color adjustments, masks and audio controls. The AI assistant can continue editing the current project, with changes recorded in undo history. Export to a chosen directory, follow render progress, or export SRT / WebVTT subtitles separately.

A placeholder still needs source media; an animation proposal still needs to be produced. Check playback and the exported file before using the result.

### Built-in animation and effect tracks

Add talking-head overlays for emphasis, speaker introductions, questions and answers, numbers or chapter titles. Adjust text, color and duration; add arrows, shapes and camera motion. Built-in presets work offline. Effects have their own track, timing range and target clips, and remain editable after AI assistance.

### Image creation and reusable templates

Manage reference images, aspect ratios, generation progress and results in the image workspace. Templates support text variables and reference images. You can also ask AI to analyze an image and save a reusable template. Creating a template and submitting an image-generation job are separate actions; online generation depends on account and model configuration.

### Daily briefs and long-term account planning

Home briefs organize news, trends and references around the account's direction, with source links, weekly browsing, unread markers and previews. Continue into topics, creation or discussion. Edit the watchlist and maintain the account plan's positioning, audience, content pillars and cadence. The plan preserves unsaved drafts and supports comparison when AI changes the same document.

### Trends, research and creator subscriptions

Browse account-relevant topics alongside platform trend lists, then discuss a promising topic with AI. Public social research can save useful findings to Knowledge. Creator subscriptions can refresh supported profiles daily and save new material; coverage and results depend on the configured data sources.

![Trends page: account-relevant topics beside platform trend lists; Chinese interface](./images/hotspots-page.jpg)

![Social research: search public posts, read relevant sources and save findings; Chinese interface](./images/automated-social-research.jpg)

![Creator subscriptions: refresh followed profiles and save new posts to Knowledge; Chinese interface](./images/creator-subscription-daily-sync.jpg)

### Creator skills and mini-apps

Browse and install curated skills for research, writing, script revision, images and video. Home mini-apps include subtitle extraction, image metadata removal, image-to-Live-Photo conversion and account planning. Metadata removal creates a separate copy; it does not remove visible logos or pixel watermarks. Live Photo support targets macOS and Windows; Linux is unsupported, and Windows device testing and phone import still need validation. Keep both paired files when transferring.

![Creator skills marketplace: filter skills by purpose and install them; Chinese interface](./images/curated-creator-skills-marketplace.jpg)

### Workspace beside the conversation

Open browser, knowledge, asset and file tabs beside chat. Drag sources into the input as references or attachments. Returning to a page shows existing workspace content while it refreshes in the background.

## Screenshots

### Knowledge

![Knowledge library: organize and reuse saved sources; Chinese interface](./images/knowledge.png)

### Comment insights — historical 2.3.0 screenshot

![Historical comment-insights screen: analyze audience questions and feedback; Chinese interface](https://github.com/Jamailar/Beav/releases/download/v2.3.0/redbox-2.3.0-comment-insights.png)

## Quick start with the desktop release

1. Install Beav from the [download page](https://beav.pro/download).
2. Create a workspace for one account or brand.
3. Open `Settings → AI` to use the official AI service or configure your own endpoint, API key and model.
4. For browser capture, get the Chrome / Edge extension from the [latest release](https://github.com/Jamailar/Beav/releases/latest).
5. Start from a topic or daily brief on Home. Open Media Workshop for video editing, or Home mini-apps for image utilities and account planning.

Ask Beav to consult its built-in user guide for the entry points in your installed version.

## Trust and boundaries

- **Local-first:** sources, manuscripts and projects are organized around local workspaces. Configured online AI and external services may process submitted content.
- **Model choice:** use the official AI service or an OpenAI-compatible provider, subject to your plan and configuration.
- **Release assets:** GitHub Releases distribute installers, extensions, updater assets and signatures.
- **Public information:** review the license, [changelog](./CHANGELOG.md), [roadmap](./ROADMAP.md) and [Issues](https://github.com/Jamailar/Beav/issues).

## Agent plugins for the desktop release

The Beav Creator plugin connects Codex Desktop or WorkBuddy to local Beav through MCP. It provides supported workspace and media tools and can delegate tasks to Beav's internal Agent. Review, approve and edit results in Beav.

Install and start Beav first (CLI users can run `beav open`), then give the appropriate instruction to the host Agent:

**Codex**

```text
/goal Read https://beav.pro/agent to install the Beav Creator plugin and set up a new task for me.
```

**WorkBuddy**

```text
Read https://beav.pro/workbuddy to install the Beav Creator plugin and connect it to my local Beav workspace.
```

After installation, describe the task in Codex or WorkBuddy. Both applications must run on the same computer as Beav. The browser UI is for human use, not an Agent control channel. These instructions target the maintained desktop release, not the 2.5.0 source snapshot.

## History and maintenance

RedBox is now **Beav**; existing local data and workspaces are unaffected. Tauri + Rust 2.5.0 is the public source baseline; later desktop releases continue in the private repository. The public repository retains the cleaned development history, and subsequent public updates go through reviewed pull requests.

[![Latest release](https://img.shields.io/github/v/release/Jamailar/Beav?style=flat-square&color=C56F2C)](https://github.com/Jamailar/Beav/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/Jamailar/Beav?style=flat-square&color=C56F2C)](https://github.com/Jamailar/Beav)
[![Release asset downloads, not users](https://img.shields.io/github/downloads/Jamailar/Beav/total?style=flat-square&color=C56F2C)](https://github.com/Jamailar/Beav/releases)
[![Source-available license](https://img.shields.io/badge/license-Source--available-6C757D?style=flat-square)](./LICENSE)

Release counts and installer counts describe published versions and files. Asset download counts are not unique users or active users.

## Community and media resources

- [Website](https://beav.pro/) · [Download](https://beav.pro/download) · [User guide](https://beav.pro/en/docs)
- [Releases](https://github.com/Jamailar/Beav/releases) · [Issues](https://github.com/Jamailar/Beav/issues)
- [Bilibili video tutorial (Chinese)](https://www.bilibili.com/video/BV12LNn6nEem/)
- For coverage, use **Beav** and **https://beav.pro/**, and describe this repository as a “Tauri + Rust 2.5.0 source snapshot + maintained desktop releases.” Do not attribute 2.8 product features to the public snapshot.
- Media assets: [capture demo](./images/plugin-save-xiaohongshu.gif), [product icon](./images/beav-icon.png) and the screenshots above. Media and licensing contact: [jambahailar@gmail.com](mailto:jambahailar@gmail.com).

Beav is developed and maintained by [第二定律工作室](https://hyperchaos.dev/). Developer: [JambaHailar](https://x.com/JambaHailar).

![Beav creator community discussion-group QR code; Chinese-language group](./images/beav-discussion-group.jpg)

## License

- **Public source:** the [Beav non-commercial source license](./LICENSE) retains the existing non-commercial restriction. Commercial use, distribution or integration requires prior written permission; contact [jambahailar@gmail.com](mailto:jambahailar@gmail.com). This is **source-available**, not standard MIT and not open source under the [OSI definition](https://opensource.org/osd).
- **Official installers:** use is governed by the in-app Beav User Agreement and the product/service entitlements listed at purchase. Availability on GitHub Releases does not license the product under the repository's source license. That source restriction does not replace the product's usage terms. Commercial use of content and AI outputs remains subject to source-material rights and service terms.
- **Third-party components:** their own licenses and copyright notices continue to apply.

## Partnerships

For brand partnerships, integrations, media or commercial licensing, contact [jambahailar@gmail.com](mailto:jambahailar@gmail.com). Prospective distributors can use the [partner application form (Chinese)](https://my.feishu.cn/share/base/form/shrcnYe6rZBbfQNvgeDIEHClWUc).

## Sponsor

[![IPWO residential proxy sponsor](./images/ipwo-sponsor.png)](https://www.ipwo.net/?ref=githubJamailar)

IPWO provides residential proxy services. [Sponsor website](https://www.ipwo.net/?ref=githubJamailar).

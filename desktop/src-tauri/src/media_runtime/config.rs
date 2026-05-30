pub(super) const MEDIA_JOB_EVENT_UPDATED: &str = "generation:job-updated";
pub(super) const MEDIA_JOB_EVENT_LOG: &str = "generation:job-log";

pub(super) const IMAGE_SUBMIT_LIMIT_PER_PROVIDER: usize = 8;
pub(super) const VIDEO_SUBMIT_LIMIT_PER_PROVIDER: usize = 4;
pub(super) const AUDIO_SUBMIT_LIMIT_PER_PROVIDER: usize = 6;
pub(super) const VOICE_CLONE_SUBMIT_LIMIT_PER_PROVIDER: usize = 2;
pub(super) const VIDEO_DOWNLOAD_LIMIT_PER_PROVIDER: usize = 3;
pub(super) const VIDEO_POLL_LIMIT_GLOBAL: usize = 32;
pub(super) const MAX_VIDEO_SEGMENT_SECONDS: i64 = 15;

pub(super) const DISPATCH_TICK_MS: u64 = 350;
pub(super) const DEFAULT_POLL_INTERVAL_MS: i64 = 2_500;
pub(super) const VIDEO_PROVIDER_POLL_TIMEOUT_MS: i64 = 2 * 60 * 60 * 1000;
pub(crate) const MEDIA_AWAIT_DEFAULT_TIMEOUT_MS: u64 = VIDEO_PROVIDER_POLL_TIMEOUT_MS as u64;
pub(super) const ACTIVE_STAGE_LEASE_MS: i64 = 20 * 60 * 1000;

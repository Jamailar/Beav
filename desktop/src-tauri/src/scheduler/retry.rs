pub const DEFAULT_HEARTBEAT_TIMEOUT_MS: i64 = 30_000;
pub const DEFAULT_MAX_ATTEMPTS: i64 = 3;

pub fn retry_delay_ms(attempt_count: i64) -> i64 {
    match attempt_count {
        i64::MIN..=1 => 5_000,
        2 => 15_000,
        _ => 60_000,
    }
}

pub fn should_dead_letter(attempt_count: i64) -> bool {
    attempt_count >= DEFAULT_MAX_ATTEMPTS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backoff_scales_with_attempts() {
        assert_eq!(retry_delay_ms(1), 5_000);
        assert_eq!(retry_delay_ms(2), 15_000);
        assert_eq!(retry_delay_ms(3), 60_000);
    }

    #[test]
    fn dead_letter_threshold_is_bounded() {
        assert!(!should_dead_letter(2));
        assert!(should_dead_letter(3));
    }
}

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct RecentLogBuffer {
    inner: Arc<Mutex<VecDeque<String>>>,
    limit: usize,
}

impl RecentLogBuffer {
    pub fn new(limit: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::with_capacity(limit.max(1)))),
            limit: limit.max(1),
        }
    }

    pub fn push(&self, line: String) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        guard.push_front(line);
        while guard.len() > self.limit {
            let _ = guard.pop_back();
        }
    }

    pub fn list(&self, limit: usize) -> Vec<String> {
        let Ok(guard) = self.inner.lock() else {
            return Vec::new();
        };
        guard.iter().take(limit.max(1)).cloned().collect()
    }
}

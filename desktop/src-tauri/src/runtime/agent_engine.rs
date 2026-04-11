use crate::runtime::{RuntimeRouteRecord, RuntimeTaskRecord};

pub fn route_for_task_snapshot(task: &RuntimeTaskRecord) -> Option<RuntimeRouteRecord> {
    task.route.clone()
}

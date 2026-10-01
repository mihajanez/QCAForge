use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;

pub struct AppHandle {
    pub last: Mutex<Instant>,
    pub start: Instant,
}
impl AppHandle {
    pub fn emit<T: Serialize>(&self, name: &str, payload: T) -> Result<(), ()> {
        if name == "robustnessProgress" {
            let mut last = self.last.lock().unwrap();
            if last.elapsed().as_secs_f64() > 10.0 {
                *last = Instant::now();
                let v = serde_json::to_value(&payload).unwrap();
                eprintln!("[{:7.1}s] progress {}/{} ({:.1}%)", self.start.elapsed().as_secs_f64(),
                    v["completed"], v["total"], v["fraction"].as_f64().unwrap_or(0.0)*100.0);
            }
        }
        Ok(())
    }
}

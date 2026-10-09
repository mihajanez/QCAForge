//! Tauri commands of the Robustness view. The sweep engine itself lives in
//! QCACore (`qca_core::analysis::robustness`), where it is shared with the
//! `qca-sim robustness` command that runs sweeps on workstations and HPC
//! clusters; this module only forwards its progress to the GUI as events.

use qca_core::analysis::robustness::{
    merge_runs, run_sweep, RobustnessConfig, RobustnessProgress, RobustnessResult, RobustnessRun,
    SweepObserver, SweepOptions, SweepPoint,
};
use qca_core::design::file::QCADesign;
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

const EVENT_ROBUSTNESS_PROGRESS: &str = "robustnessProgress";
const EVENT_ROBUSTNESS_POINT: &str = "robustnessPoint";

#[derive(Default)]
pub struct RobustnessState {
    cancel: Arc<AtomicBool>,
    running: AtomicBool,
}

struct EventObserver<'a> {
    app: &'a AppHandle,
}

impl SweepObserver for EventObserver<'_> {
    fn progress(&self, progress: &RobustnessProgress) {
        let _ = self.app.emit(EVENT_ROBUSTNESS_PROGRESS, progress);
    }

    fn point(&self, point: &SweepPoint) {
        let _ = self.app.emit(EVENT_ROBUSTNESS_POINT, point);
    }
}

#[tauri::command(async)]
pub fn run_robustness_analysis(
    app: AppHandle,
    qca_design: Value,
    config: RobustnessConfig,
) -> Result<RobustnessResult, String> {
    let nominal: QCADesign =
        serde_json::from_value(qca_design.clone()).map_err(|e| format!("Invalid design: {}", e))?;
    let state = app.state::<RobustnessState>();
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A robustness analysis is already running".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let options = SweepOptions {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        ..Default::default()
    };
    let result = run_sweep(
        &EventObserver { app: &app },
        qca_design,
        nominal,
        config,
        state.cancel.clone(),
        options,
    );
    state.running.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub fn cancel_robustness_analysis(app: AppHandle) {
    app.state::<RobustnessState>()
        .cancel
        .store(true, Ordering::SeqCst);
}

#[derive(Serialize)]
pub struct MergedRuns {
    run: RobustnessRun,
    runs: usize,
    points: usize,
    duplicates: usize,
    missing: usize,
}

/// Merges run files of the same sweep, e.g. the partial results of the tasks
/// of a cluster job array (`qca-sim robustness run --slice k/N`).
#[tauri::command]
pub fn merge_robustness_runs(contents: Vec<String>, name: String) -> Result<MergedRuns, String> {
    let runs = contents
        .iter()
        .map(|text| RobustnessRun::from_json(text))
        .collect::<Result<Vec<_>, _>>()?;
    let (run, report) = merge_runs(&name, runs)?;
    Ok(MergedRuns {
        run,
        runs: report.runs,
        points: report.points,
        duplicates: report.duplicates,
        missing: report.missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_file(slice: usize, points: &[(usize, f64)]) -> String {
        serde_json::json!({
            "format": "qcaforge-robustness-analysis",
            "version": 1,
            "name": format!("part {}", slice),
            "created_at": "2026-10-09T00:00:00Z",
            "model_id": "icha_model",
            "x": { "parameter": "geometry.cell_size", "name": "Cell size", "values": [50.0, 60.0, 70.0] },
            "y": null,
            "config": {
                "x_axis": { "parameter": "geometry.cell_size", "values": [50.0, 60.0, 70.0] },
                "y_axis": null,
                "expected_behavior": "wire",
                "thresholds": { "clock": 0.05, "logical": 0.05, "value": 0.8 },
                "slice": { "index": slice, "count": 2 }
            },
            "columns": [{ "label": "In", "is_output": false }, { "label": "Out", "is_output": true }],
            "reference_truth_table": null,
            "points": points.iter().map(|(ix, x)| serde_json::json!({
                "ix": ix, "iy": 0, "x": x, "y": null, "accuracy": 1.0, "error": null,
                "truth_table": { "rows": [["A", "A"]] }, "row_accuracy": [1.0],
                "design_file": null, "simulation_file": null, "duration_ms": 10
            })).collect::<Vec<_>>(),
            "cancelled": false,
            "duration_ms": 20
        })
        .to_string()
    }

    #[test]
    fn merges_partial_runs() {
        let parts = vec![
            run_file(0, &[(0, 50.0), (2, 70.0)]),
            run_file(1, &[(1, 60.0)]),
        ];
        let merged = merge_robustness_runs(parts, "merged".into()).unwrap();
        assert_eq!((merged.runs, merged.points, merged.missing), (2, 3, 0));
        assert_eq!(
            merged.run.points.iter().map(|p| p.ix).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );

        let incomplete =
            merge_robustness_runs(vec![run_file(0, &[(0, 50.0)])], "x".into()).unwrap();
        assert_eq!(incomplete.missing, 2);
        assert!(merge_robustness_runs(vec!["{}".into()], "x".into()).is_err());
    }
}

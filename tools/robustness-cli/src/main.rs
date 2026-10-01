//! Headless front end to the QCAForge robustness-analysis engine
//! (src-tauri/src/robustness.rs). Usage:
//!   qcaforge-robustness <design.qcd> <config.json> <out_run.json> [name]
//! Writes a `qcaforge-robustness-analysis` run file that the QCAForge
//! Robustness view can open directly.
mod robustness;
mod shim;
mod simulation;

use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;

fn axis_info(axis: &Value, nominal: &Value) -> Value {
    let p = axis["parameter"].as_str().unwrap_or("");
    let (name, unit): (&str, Option<&str>) = match p {
        "geometry.cell_size" => ("Cell size (intercell distance)", Some("nm")),
        "geometry.dot_radius" => ("Quantum dot placement radius", Some("nm")),
        "geometry.dot_diameter" => ("Quantum dot diameter", Some("nm")),
        _ => (p, None),
    };
    let mut v = json!({"parameter": p, "name": name, "values": axis["values"], "nominal": nominal});
    if let Some(u) = unit { v["unit"] = json!(u); }
    v
}

fn dump(args: &[String]) {
    // qcaforge-robustness dump <design.qcd> <out.json>
    let design_file: Value = serde_json::from_str(&std::fs::read_to_string(&args[2]).unwrap()).unwrap();
    let mut raw = design_file["design"].clone();
    if let Some(settings) = raw["simulation_settings"].as_object_mut() {
        settings.entry("use_custom_input_sequence").or_insert(Value::Bool(false));
        settings.entry("custom_input_sequence").or_insert(Value::Array(vec![]));
    }
    let design: qca_core::design::file::QCADesign = serde_json::from_value(raw).expect("invalid design");
    let (model, seq) = simulation::prepare_simulation(&design).expect("prepare");
    let t = Instant::now();
    let data = qca_core::simulation::run_simulation(model, design.layers.clone(), design.cell_architectures.clone(), seq);
    let cells: Vec<Value> = data.cells_data.iter().map(|c| {
        let cell = &design.layers[c.index.layer].cells[c.index.cell];
        json!({"layer": c.index.layer, "cell": c.index.cell, "label": cell.label, "data": c.data})
    }).collect();
    let out = json!({"num_samples": data.metadata.num_samples, "clock": data.clock_data, "cells": cells,
                     "seconds": t.elapsed().as_secs_f64()});
    std::fs::write(&args[3], serde_json::to_string(&out).unwrap()).unwrap();
    eprintln!("dump: {} samples in {:.1}s", data.metadata.num_samples, t.elapsed().as_secs_f64());
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args[1] == "dump" { dump(&args); return; }
    let design_file: Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let mut config: Value = serde_json::from_str(&std::fs::read_to_string(&args[2]).unwrap()).unwrap();
    let name = args.get(4).cloned().unwrap_or_else(|| args[1].clone());
    let mut raw = design_file["design"].clone();
    // Older example files predate these fields; the GUI always sends them.
    if let Some(settings) = raw["simulation_settings"].as_object_mut() {
        settings.entry("use_custom_input_sequence").or_insert(Value::Bool(false));
        settings.entry("custom_input_sequence").or_insert(Value::Array(vec![]));
    }
    config["designer_properties"] = design_file["designer_properties"].clone();
    let nominal = serde_json::from_value(raw.clone()).expect("invalid design");
    let config = serde_json::from_value(config).expect("invalid config");
    let app = shim::AppHandle { last: Mutex::new(Instant::now()), start: Instant::now() };
    let result = robustness::run_sweep(&app, raw, nominal, config, Arc::new(AtomicBool::new(false)))
        .expect("robustness analysis failed");
    let r = serde_json::to_value(&result).unwrap();
    let run = json!({
        "format": "qcaforge-robustness-analysis",
        "version": 1,
        "name": name,
        "created_at": chrono::Utc::now().to_rfc3339(),
        "model_id": r["model_id"],
        "x": axis_info(&r["config"]["x_axis"], &r["nominal_x"]),
        "y": if r["config"]["y_axis"].is_null() { Value::Null } else { axis_info(&r["config"]["y_axis"], &r["nominal_y"]) },
        "expected_behavior": r["config"]["expected_behavior"],
        "config": r["config"],
        "columns": r["columns"],
        "reference_truth_table": r["reference_truth_table"],
        "points": r["points"],
        "cancelled": r["cancelled"],
        "duration_ms": r["duration_ms"],
    });
    std::fs::write(&args[3], serde_json::to_string(&run).unwrap()).unwrap();
    let pts = r["points"].as_array().unwrap();
    let total_ms: u64 = pts.iter().map(|p| p["duration_ms"].as_u64().unwrap_or(0)).sum();
    let errs = pts.iter().filter(|p| !p["error"].is_null()).count();
    eprintln!("done: {} points, wall {:.1}s, cpu-sum {:.1}s, errors {}", pts.len(),
        result_duration(&r), total_ms as f64 / 1000.0, errs);
}
fn result_duration(r: &Value) -> f64 { r["duration_ms"].as_f64().unwrap_or(0.0) / 1000.0 }

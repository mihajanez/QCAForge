# qcaforge-robustness — headless robustness runner

A command-line front end to the QCAForge robustness-analysis engine
(`src-tauri/src/robustness.rs`). It runs the same sweep → simulate → score
pipeline as the **Robustness** view, but without the GUI, so large sweeps can be
run on a server or an HPC cluster (e.g. FRIDA) and inspected afterwards in
QCAForge.

`src/robustness.rs` is `src-tauri/src/robustness.rs` with the Tauri command
wrappers removed (`AppHandle` is replaced by a small progress shim in
`src/shim.rs`); `src/simulation.rs` is the model-construction part of
`src-tauri/src/simulation.rs`. Scoring, variant generation and truth-table
extraction are therefore identical to the desktop application.

## Build

```bash
cargo build --release          # standalone crate, not part of the app workspace
```

## Usage

```bash
qcaforge-robustness <design.qcd> <config.json> <run.json> [name]
```

* `design.qcd` – nominal design (as saved by QCAForge)
* `config.json` – a `RobustnessConfig` (same fields the GUI sends), e.g.

```json
{"x_axis": {"parameter": "geometry.cell_size", "values": [50, 55, 60]},
 "y_axis": {"parameter": "geometry.dot_radius", "values": [14, 16, 18]},
 "expected_behavior": "majority", "cell_clock_delays": {},
 "thresholds": {"clock": 0.05, "logical": 0.05, "value": 0.8},
 "output_dir": null, "base_name": "design", "max_threads": 2}
```

* `run.json` – output in the `qcaforge-robustness-analysis` format; open it in
  QCAForge → Robustness → *Open results*.

Progress is printed to stderr every 10 s.

## Suggested next step

Move the non-GUI part of `robustness.rs` into `qca-core` (e.g.
`qca_core::analysis::robustness`) and expose it both to the Tauri command and as
a `qca-sim robustness` subcommand, so that there is a single implementation.

### Polarization traces

```bash
qcaforge-robustness dump <design.qcd> <traces.json>
```

simulates the design once and writes the polarization trace of every stored
(input/output) cell together with the clock signals, which is convenient for
debugging sequential circuits such as the ternary T flip-flop with reset
(`article-robustness/designs/ternary-flipflop-reset.qcd`, expected behaviour
`ternary_flipflop`).

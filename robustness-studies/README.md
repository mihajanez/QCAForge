# Robustness studies of ternary QCA structures

This directory contains the designs, sweep configurations and results of
robustness and fault-tolerance studies of ternary (eight-dot) QCA structures,
all computed with the robustness engine of QCACore: interactively in the
Robustness view of QCAForge, with `qca-sim robustness` of
[QCASim](https://github.com/mihajanez/QCASim), or as Slurm job arrays on an
HPC cluster. Every run file (`*.json` without the `cfg_` prefix) opens in
QCAForge under **Robustness → Open results**.

All studies use the ICHA model with at most 1,000 self-consistency and
eigensolver iterations, 20 samples per input combination and the nominal
architecture of the *Tri state 60* cell (inter-cell distance 60 nm, dot
diameter 10 nm, dot placement radius 14 nm).

## Contents

| Path | Content |
|---|---|
| `designs/` | nominal designs: wire, clocked wire, inverter, classical and diagonal majority gate, memorizing cell, ternary T flip-flop with reset; cells labelled `U` (inverter branch) and `M` (majority device cell) are displaced in the displacement sweeps; the majority gates carry a custom input sequence of the 27 combinations of {A, B, C} |
| `designs/order/` | the same designs with the other cell update orders of the ICHA model (`u1` reverse, `u2s1`–`u2s5` random with seeds 1–5, `u3` simultaneous) |
| `runs/cfg_*.json` | sweep configurations |
| `runs/e1_*` … `runs/e5_*` | run files (2-vCPU workstation, 2 worker threads) |
| `runs/full-grid/` | configurations of the full-resolution geometry grids and of the flip-flop geometry sweep |
| `defects.zip` | single-cell defects at the nominal architecture: one design and one run file per missing cell or cell stuck at state A, B or C |
| `frida-campaign.tsv` | the complete campaign as a table for `hpc/frida/submit-campaign.sh` of QCASim |
| `frida-order-campaign.tsv` | the global geometry sweeps, the memorizing cell and the flip-flop with every cell update order |
| `results/frida-campaign/` | merged run files and `summary.tsv` of `frida-campaign.tsv`, computed on the FRIDA cluster |

## Studies

* **Global cell geometry** (`e1_*`): inter-cell distance 50:5:150 nm ×
  dot placement radius 14:2:30 nm (189 variants per structure); the
  full-resolution grids (`t1_*`) use 50:3.125:150 nm × 14:0.5:24 nm
  (693 variants).
* **Single-cell displacement** (`e2_*`): inter-cell distance 60:20:120 nm ×
  displacement of the labelled cell −24:4:24 nm.
* **Dielectric environment** (`e3_*`): relative permittivity 9:0.5:15.
* **Memorizing cell** (`e5_memory-cell`): inter-cell distance 50:10:150 nm ×
  dot placement radius 14:4:30 nm.
* **Cell defects** (`defects.zip`): every cell except inputs and outputs
  removed or stuck at A, B or C, one at a time.
* **Ternary T flip-flop with reset** (`designs/ternary-flipflop-reset.qcd`,
  66 cells, inputs T and R, output Q): the design carries an 18-step input
  sequence; `runs/cfg_ternary-flipflop.json` scores it with the expected
  behaviour `ternary_flipflop` (each row against the previous Q) and the
  clock delays R: 1 and Q: 1. R = A resets Q to A; otherwise T = A holds,
  T = B toggles and T = C clears to 0. `runs/full-grid/t2_ternary-flipflop.json`
  sweeps its geometry (13 × 7 variants).

## Running the campaigns on an HPC cluster

With QCASim cloned on the login node of a Slurm cluster (see its
[`hpc/frida/README.md`](https://github.com/mihajanez/QCASim/blob/master/hpc/frida/README.md)):

```bash
cd robustness-studies
~/QCASim/hpc/frida/submit-campaign.sh frida-campaign.tsv
~/QCASim/hpc/frida/submit-campaign.sh frida-order-campaign.tsv
```

Each campaign writes one run directory per sweep and a `summary.tsv` with
the correctness, missing and failed points and the CPU time of every sweep.

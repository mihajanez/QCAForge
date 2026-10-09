# Robustness and fault-tolerance campaign (article Section 4)

All runs were produced with the QCAForge robustness engine (headless runner,
then in `tools/robustness-cli`, now `qca-sim robustness` of QCASim) on a 2-vCPU Linux VM (Intel Xeon 2.1 GHz), 2 worker
threads, 29 Sep 2026. Total simulation wall time: 6015 s (100 min), 1345
simulations, 3.3 core-hours (see `campaign.log`).

* `designs/` – nominal designs (examples from `examples/`, with
  `max_iterations = schur_max_iterations = 1000`; cells labelled `U` (inverter
  branch) and `M` (majority device cell) for the displacement sweeps; majority
  gates use a custom input sequence of the 27 canonical combinations {A,B,C}^3).
* `runs/` – robustness runs; every `*.json` without the `cfg_` prefix can be
  opened directly in QCAForge → Robustness → *Open results*.
  * `e1_*` global architecture: cell size 50:5:150 nm × dot radius 14:2:30 nm
  * `e2_*` single-cell displacement: cell size 60:20:120 × offset −24:4:24 nm
  * `e3_*` relative permittivity 9:0.5:15
  * `e5_memory-cell` memorizing cell: cell size 50:10:150 × radius 14:4:30
* `defects/` – single-cell defects (missing / stuck at A, B, C) at the nominal
  architecture; one design and one run file per defect.


## Ternary T flip-flop with reset (Section 5.2 of the article)

- `designs/ternary-flipflop-reset.qcd` - the flip-flop layout (d = 60 nm, r = 14 nm, 66 cells).
  Inputs T and R, output Q. It carries the 18-cycle custom input sequence of the step table (16 commands, an idle command
  and the cycle that applies its R); R is applied one clock cycle after the T value of the same command.
- `runs/cfg_ternary-flipflop.json` - robustness configuration for the new expected behaviour
  `ternary_flipflop` (scored sequentially, each row against the previous Q) with the cell clock
  delays R: 1 and Q: 1, so that each truth-table row holds one command (T_i, R_i, Q_i).
- Operation: R = A (-1) resets Q to A; otherwise T = A holds, T = B toggles, T = C clears to 0.
- ICHA result at 60/14 and 80/16: 15 of 16 transitions correct; the neutral state produced by a
  clear is not retained by the following hold (lost at the diagonal steps into the gate corners).

## Reproducing the campaign on an HPC cluster

`frida-campaign.tsv` lists the sweeps of this campaign for
`hpc/frida/submit-campaign.sh` of [QCASim](https://github.com/mihajanez/QCASim)
(see its `hpc/frida/README.md`):

```bash
~/QCASim/hpc/frida/submit-campaign.sh frida-campaign.tsv
```

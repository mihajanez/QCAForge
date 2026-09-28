import { invoke } from "@tauri-apps/api/core";
import { CellType } from "$lib/Cell";
import type { QCADesign } from "$lib/qca-design";

export const EVENT_ROBUSTNESS_PROGRESS = "robustnessProgress";
export const EVENT_ROBUSTNESS_POINT = "robustnessPoint";

export const ROBUSTNESS_RUN_FORMAT = "qcaforge-robustness-analysis";
export const ROBUSTNESS_RUN_VERSION = 1;
/** Same file names the QCASim analysis scripts use. */
export const TRUTH_ANALYSIS_CSV = "truth_analysis.csv";
export const ROBUSTNESS_RUN_JSON = "robustness_analysis.json";

export type ExpectedBehavior =
	| "reference"
	| "wire"
	| "inverter"
	| "majority"
	| "memory_cell"
	| "flipflop1";

export interface ExpectedBehaviorInfo {
	id: ExpectedBehavior;
	name: string;
	description: string;
}

/** Comparisons ported from QCASim's `scripts/analyze_truth.py`. */
export const EXPECTED_BEHAVIORS: ExpectedBehaviorInfo[] = [
	{
		id: "reference",
		name: "Nominal design (reference)",
		description:
			"Output cells must match the truth table of the unmodified design.",
	},
	{
		id: "wire",
		name: "Wire",
		description:
			"First column is the input; every other column must repeat it.",
	},
	{
		id: "inverter",
		name: "Inverter",
		description:
			"First column is the input; the last column must be its inverse.",
	},
	{
		id: "majority",
		name: "Majority gate",
		description:
			"Three input columns and one output column (tri-state majority).",
	},
	{
		id: "memory_cell",
		name: "Memory cell",
		description: "Three columns (X, W, Q); Q must follow W.",
	},
	{
		id: "flipflop1",
		name: "Flip-flop 1",
		description: "Three columns (Flip, G1, Q).",
	},
];

export interface TruthTableThresholds {
	clock: number;
	logical: number;
	value: number;
}

/** Defaults of `qca-sim truth`, which the scripts use. */
export const DEFAULT_THRESHOLDS: TruthTableThresholds = {
	clock: 0.05,
	logical: 0.05,
	value: 0.8,
};

export interface SweepAxisConfig {
	parameter: string;
	values: number[];
}

export interface RobustnessConfig {
	x_axis: SweepAxisConfig;
	y_axis: SweepAxisConfig | null;
	expected_behavior: ExpectedBehavior;
	cell_clock_delays: Record<string, number>;
	thresholds: TruthTableThresholds;
	output_dir: string | null;
	base_name: string;
	designer_properties: unknown;
	max_threads: number | null;
}

export interface TruthTableData {
	rows: (string | null)[][];
}

export interface SweepPoint {
	ix: number;
	iy: number;
	x: number;
	y: number | null;
	accuracy: number | null;
	error: string | null;
	truth_table: TruthTableData | null;
	row_accuracy: number[];
	design_file: string | null;
	simulation_file: string | null;
	duration_ms: number;
}

export interface RobustnessColumn {
	label: string;
	is_output: boolean;
}

export interface RobustnessResult {
	config: RobustnessConfig;
	model_id: string;
	nominal_x: number;
	nominal_y: number | null;
	columns: RobustnessColumn[];
	reference_truth_table: TruthTableData | null;
	points: SweepPoint[];
	cancelled: boolean;
	duration_ms: number;
}

export interface RobustnessProgress {
	completed: number;
	total: number;
	fraction: number;
}

export interface AxisInfo {
	parameter: string;
	name: string;
	unit?: string;
	values: number[];
	nominal?: number;
}

/** A finished, running or imported analysis as shown by the GUI. */
export interface RobustnessRun {
	format: typeof ROBUSTNESS_RUN_FORMAT;
	version: number;
	name: string;
	created_at: string;
	model_id?: string;
	x: AxisInfo;
	y: AxisInfo | null;
	expected_behavior?: ExpectedBehavior;
	config?: RobustnessConfig;
	columns: RobustnessColumn[];
	reference_truth_table: TruthTableData | null;
	points: SweepPoint[];
	cancelled: boolean;
	duration_ms: number;
	/** Set when the run was merged from truth_analysis.csv files. */
	source_files?: string[];
}

/**
 * Inclusive `start:stop:step` range, the syntax the Python scripts use.
 * Returns an error message for an invalid range.
 */
export function rangeValues(
	start: number,
	stop: number,
	step: number,
	wholeNumbers = false,
): number[] | string {
	if (![start, stop, step].every(Number.isFinite))
		return "Enter a start, stop and step value.";
	if (start === stop) return [wholeNumbers ? Math.round(start) : start];
	if (step <= 0) return "Step must be positive.";
	if (stop < start) return "Stop must not be smaller than start.";
	const count = Math.floor((stop - start) / step + 1e-9) + 1;
	if (count > 10_000) return "Too many values (maximum 10000).";
	const values = Array.from({ length: count }, (_, i) => {
		const value = start + i * step;
		return wholeNumbers
			? Math.round(value)
			: Math.round(value * 1e9) / 1e9;
	});
	return [...new Set(values)];
}

/** Input/output cells in truth table column order (as the simulation stores them). */
export function getStoredColumns(design: QCADesign): RobustnessColumn[] {
	const columns: RobustnessColumn[] = [];
	design.layers.forEach((layer, l) =>
		layer.cells.forEach((cell, c) => {
			if (cell.typ === CellType.Input || cell.typ === CellType.Output) {
				columns.push({
					label: cell.label || `${l}-${c}`,
					is_output: cell.typ === CellType.Output,
				});
			}
		}),
	);
	return columns;
}

/** Mirrors ExpectedBehavior::validate_columns in robustness.rs. */
export function validateColumns(
	behavior: ExpectedBehavior,
	columns: RobustnessColumn[],
): string | undefined {
	const n = columns.length;
	switch (behavior) {
		case "reference":
			return columns.some((c) => c.is_output)
				? undefined
				: "The design needs at least one output cell.";
		case "wire":
		case "inverter":
			return n >= 2
				? undefined
				: "Needs at least 2 input/output cells (input first).";
		case "majority":
			return n === 4
				? undefined
				: `Needs exactly 4 input/output cells, the design has ${n}.`;
		case "memory_cell":
		case "flipflop1":
			return n === 3
				? undefined
				: `Needs exactly 3 input/output cells, the design has ${n}.`;
	}
}

export function runRobustnessAnalysis(
	qcaDesign: QCADesign,
	config: RobustnessConfig,
): Promise<RobustnessResult> {
	return invoke("run_robustness_analysis", { qcaDesign, config });
}

export function cancelRobustnessAnalysis(): Promise<void> {
	return invoke("cancel_robustness_analysis");
}

export function formatNumber(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value))
		return "–";
	if (value !== 0 && (Math.abs(value) >= 1e5 || Math.abs(value) < 1e-3))
		return value.toExponential(3).replace(/\.?0+e/, "e");
	return String(Math.round(value * 1e4) / 1e4);
}

export function formatAxisLabel(axis: AxisInfo | null | undefined): string {
	if (!axis) return "";
	return axis.unit ? `${axis.name} (${axis.unit})` : axis.name;
}

// ---------------------------------------------------------------------------
// CSV compatibility with analyze_truth.py / visualize_truth.py
// ---------------------------------------------------------------------------

/** `x_coord,y_coord,accuracy`, as written by analyze_truth.py. */
export function runToCsv(run: RobustnessRun): string {
	const lines = ["x_coord,y_coord,accuracy"];
	for (const point of run.points) {
		if (point.accuracy === null) continue;
		lines.push(`${point.x},${point.y ?? 0},${point.accuracy}`);
	}
	return lines.join("\n") + "\n";
}

function parseCsv(content: string): { x: number; y: number; accuracy: number }[] {
	const lines = content.split(/\r?\n/).filter((line) => line.trim());
	if (lines.length === 0) throw new Error("The file is empty.");
	const header = lines[0].split(",").map((h) => h.trim());
	const xi = header.indexOf("x_coord");
	const yi = header.indexOf("y_coord");
	const ai = header.indexOf("accuracy");
	if (xi < 0 || yi < 0 || ai < 0)
		throw new Error(
			"Expected the columns x_coord, y_coord and accuracy (truth_analysis.csv).",
		);
	return lines.slice(1).map((line) => {
		const cols = line.split(",");
		return {
			x: parseFloat(cols[xi]),
			y: parseFloat(cols[yi]),
			accuracy: parseFloat(cols[ai]),
		};
	});
}

/**
 * Merges truth_analysis.csv files the way visualize_truth.py does: the
 * accuracies of every file are multiplied per (x, y) coordinate.
 */
export function mergeCsvFiles(
	files: { name: string; content: string }[],
): { run: RobustnessRun; warnings: string[] } {
	const byCoord = new Map<string, { x: number; y: number; values: number[] }>();
	for (const file of files) {
		for (const row of parseCsv(file.content)) {
			if (![row.x, row.y, row.accuracy].every(Number.isFinite)) continue;
			const key = `${row.x}|${row.y}`;
			const entry = byCoord.get(key) ?? { x: row.x, y: row.y, values: [] };
			entry.values.push(row.accuracy);
			byCoord.set(key, entry);
		}
	}
	const warnings: string[] = [];
	const entries = [...byCoord.values()];
	const missing = entries.filter((e) => e.values.length < files.length);
	if (missing.length > 0)
		warnings.push(
			`${missing.length} coordinate(s) are missing from some files; their accuracy is the product of the available values.`,
		);
	if (entries.length === 0) throw new Error("No data rows found.");

	const xs = [...new Set(entries.map((e) => e.x))].sort((a, b) => a - b);
	const ys = [...new Set(entries.map((e) => e.y))].sort((a, b) => a - b);
	const points: SweepPoint[] = entries.map((e) => ({
		ix: xs.indexOf(e.x),
		iy: ys.indexOf(e.y),
		x: e.x,
		y: ys.length > 1 ? e.y : null,
		accuracy: e.values.reduce((a, b) => a * b, 1),
		error: null,
		truth_table: null,
		row_accuracy: [],
		design_file: null,
		simulation_file: null,
		duration_ms: 0,
	}));
	return {
		run: {
			format: ROBUSTNESS_RUN_FORMAT,
			version: ROBUSTNESS_RUN_VERSION,
			name: files.map((f) => f.name).join(" × "),
			created_at: new Date().toISOString(),
			x: { parameter: "x_coord", name: "x", values: xs },
			y:
				ys.length > 1
					? { parameter: "y_coord", name: "y", values: ys }
					: null,
			columns: [],
			reference_truth_table: null,
			points,
			cancelled: false,
			duration_ms: 0,
			source_files: files.map((f) => f.name),
		},
		warnings,
	};
}

export function parseRunJson(content: string): RobustnessRun {
	const run = JSON.parse(content) as RobustnessRun;
	if (run.format !== ROBUSTNESS_RUN_FORMAT || !run.x || !run.points)
		throw new Error("Not a QCAForge robustness analysis file.");
	return run;
}

// ---------------------------------------------------------------------------
// Plot data
// ---------------------------------------------------------------------------

export interface AccuracyGrid {
	xs: number[];
	/** undefined for a one-parameter sweep */
	ys: number[] | undefined;
	/** values[iy][ix]; null where no (successful) result exists yet */
	values: (number | null)[][];
	points: (SweepPoint | undefined)[][];
}

export function buildGrid(run: RobustnessRun): AccuracyGrid {
	const xs = run.x.values;
	const ys = run.y?.values;
	const rows = ys?.length ?? 1;
	const values: (number | null)[][] = Array.from({ length: rows }, () =>
		Array(xs.length).fill(null),
	);
	const points: (SweepPoint | undefined)[][] = Array.from(
		{ length: rows },
		() => Array(xs.length).fill(undefined),
	);
	for (const point of run.points) {
		if (point.iy >= rows || point.ix >= xs.length) continue;
		values[point.iy][point.ix] = point.accuracy;
		points[point.iy][point.ix] = point;
	}
	return { xs, ys, values, points };
}

export function summarizeRun(run: RobustnessRun) {
	const accuracies = run.points
		.map((p) => p.accuracy)
		.filter((a): a is number => a !== null);
	const failed = run.points.filter((p) => p.error).length;
	return {
		count: run.points.length,
		failed,
		fullyCorrect: accuracies.filter((a) => a >= 1 - 1e-9).length,
		mean: accuracies.length
			? accuracies.reduce((a, b) => a + b, 0) / accuracies.length
			: undefined,
		min: accuracies.length ? Math.min(...accuracies) : undefined,
	};
}

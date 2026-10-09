import { expect, test, vi } from "vitest";

// Opens a Tauri store on import, which is unavailable in tests.
vi.mock("$lib/last-directory", () => ({ lastDirectoryManager: {} }));
import {
	buildGrid,
	clusterConfig,
	clusterSubmitScript,
	defaultClusterTasks,
	getStoredColumns,
	mergeCsvFiles,
	rangeValues,
	runToCsv,
	validateColumns,
} from "$lib/robustness/robustness";
import { collectParameters } from "$lib/model-parameters";
import { createCellArchitecture } from "$lib/CellArchitecture";
import { CellType, type Cell } from "$lib/Cell";
import type { Layer } from "$lib/Layer";
import type { SimulationModel } from "$lib/SimulationModel";

function cell(typ: CellType, label?: string): Cell {
	return {
		position: [0, 0],
		rotation: 0,
		typ,
		clock_phase_shift: 0,
		dot_probability_distribution: [],
		label,
	};
}

const layers: Layer[] = [
	{
		name: "Main",
		visible: true,
		cell_architecture_id: "arch",
		z_position: 0,
		cells: [
			cell(CellType.Input, "In"),
			cell(CellType.Normal),
			cell(CellType.Output, "Out"),
		],
	},
];

test("rangeValues is inclusive and rounds float noise", () => {
	expect(rangeValues(50, 60, 5)).toEqual([50, 55, 60]);
	expect(rangeValues(0.1, 0.3, 0.1)).toEqual([0.1, 0.2, 0.3]);
	expect(rangeValues(14, 15, 0.5)).toEqual([14, 14.5, 15]);
	expect(rangeValues(3, 3, 0)).toEqual([3]);
	expect(rangeValues(1, 4, 1.5, true)).toEqual([1, 3, 4]);
	expect(typeof rangeValues(0, 1, 0)).toBe("string");
	expect(typeof rangeValues(2, 1, 1)).toBe("string");
});

test("stored columns follow input/output cells in order", () => {
	const design: any = { layers };
	const columns = getStoredColumns(design);
	expect(columns).toEqual([
		{ label: "In", is_output: false },
		{ label: "Out", is_output: true },
	]);
	expect(validateColumns("inverter", columns)).toBeUndefined();
	expect(validateColumns("majority", columns)).toBeDefined();
});

test("CSV export matches analyze_truth.py and merging multiplies like visualize_truth.py", () => {
	const a = "x_coord,y_coord,accuracy\n60.0,14.0,1.0\n60.0,15.0,0.5\n65.0,14.0,0.75\n";
	const b = "x_coord,y_coord,accuracy\n60.0,14.0,0.5\n60.0,15.0,0.5\n";
	const { run, warnings } = mergeCsvFiles([
		{ name: "a", content: a },
		{ name: "b", content: b },
	]);
	expect(warnings.length).toBe(1); // (65, 14) missing from b
	expect(run.x.values).toEqual([60, 65]);
	expect(run.y!.values).toEqual([14, 15]);

	const grid = buildGrid(run);
	expect(grid.values).toEqual([
		[0.5, 0.75],
		[0.25, null],
	]);

	const csv = runToCsv(run);
	expect(csv.split("\n")[0]).toBe("x_coord,y_coord,accuracy");
	expect(csv).toContain("60,15,0.25");
});

test("one-parameter CSV becomes a 1D run", () => {
	const { run } = mergeCsvFiles([
		{ name: "a", content: "x_coord,y_coord,accuracy\n1,0,1\n2,0,0.5\n" },
	]);
	expect(run.y).toBeNull();
	expect(buildGrid(run).values).toEqual([[1, 0.5]]);
});

test("collectParameters lists geometry, model and clock parameters", () => {
	const architectures = new Map([
		["arch", createCellArchitecture("Tri", 60, 10, 8, 14, "arch")],
	]);
	const model: SimulationModel = {
		id: "icha_model",
		name: "ICHA",
		model_option_list: [
			{ type: "Header", label: "x" },
			{
				type: "Input",
				unique_id: "relative_permitivity",
				name: "Relative Permittivity",
				description: "",
				descriptor: { type: "NumberInput", whole_num: false },
			},
		],
		model_settings: { relative_permitivity: 12.9 },
		clock_generator_option_list: [
			{
				type: "Input",
				unique_id: "num_cycles",
				name: "Number of Cycles",
				description: "",
				descriptor: { type: "NumberInput", whole_num: true, min: 1 },
			},
		],
		clock_generator_settings: { num_cycles: 1 },
	};
	const parameters = collectParameters(layers, architectures, model);
	const byId = Object.fromEntries(parameters.map((p) => [p.id, p]));

	expect(byId["geometry.cell_size"].value).toBe(60);
	expect(byId["geometry.dot_radius"].value).toBeCloseTo(14);
	expect(byId["geometry.layer_z:0"].value).toBe(0);
	expect(byId["geometry.cell_offset_y:Out"].value).toBe(0);
	expect(byId["model.relative_permitivity"].value).toBe(12.9);
	expect(byId["clock.num_cycles"].whole_num).toBe(true);
	expect(parameters.some((p) => p.id.includes("Header"))).toBe(false);
});

test("model parameter export has the structure model_params.py reads", async () => {
	const { buildModelParametersExport } = await import("$lib/model-parameters");
	const architectures = new Map([
		["arch", createCellArchitecture("Tri", 60, 10, 8, 14, "arch")],
		["unused", createCellArchitecture("Other", 20, 5, 4, 6, "unused")],
	]);
	const model: SimulationModel = {
		id: "bistable",
		name: "Bistable",
		model_option_list: [],
		model_settings: { relative_permitivity: 12.9 },
		clock_generator_option_list: [],
		clock_generator_settings: { num_cycles: 1 },
	};
	const exported = buildModelParametersExport(
		layers,
		architectures,
		model,
		"0.2.0",
		"C:/designs/line.qcd",
	);
	expect(exported.format).toBe("qcaforge-model-parameters");
	expect(exported.model).toEqual({ id: "bistable", name: "Bistable" });
	expect(exported.model_settings).toEqual({ relative_permitivity: 12.9 });
	expect(exported.clock_generator_settings).toEqual({ num_cycles: 1 });
	expect(Object.keys(exported.cell_architectures)).toEqual(["arch"]);
	for (const parameter of exported.parameters) {
		expect(typeof parameter.id).toBe("string");
		expect(typeof parameter.value).toBe("number");
		expect(typeof parameter.whole_num).toBe("boolean");
	}
	// Round-trips through JSON (Maps would silently become {}).
	expect(JSON.parse(JSON.stringify(exported)).cell_architectures.arch.side_length).toBe(60);
});

test("cluster job export", () => {
	expect(defaultClusterTasks(121, 16)).toBe(2);
	expect(defaultClusterTasks(3, 16)).toBe(1);
	expect(defaultClusterTasks(100000, 1)).toBe(1000);
	expect(defaultClusterTasks(5, 1)).toBe(2);

	const config = clusterConfig({
		x_axis: { parameter: "geometry.cell_size", values: [50, 60] },
		y_axis: null,
		expected_behavior: "wire",
		cell_clock_delays: {},
		thresholds: { clock: 0.05, logical: 0.05, value: 0.8 },
		output_dir: "/local/only",
		base_name: "line",
		designer_properties: { camera_zoom_enabled: true },
		max_threads: 8,
	});
	// Local-only settings are not exported; the cluster decides threads and files.
	expect(Object.keys(config).sort()).toEqual([
		"base_name",
		"cell_clock_delays",
		"expected_behavior",
		"thresholds",
		"x_axis",
		"y_axis",
	]);

	const script = clusterSubmitScript({
		name: "it's a test",
		points: 10,
		cpusPerTask: 4,
		tasks: 3,
		partition: "amd",
		timeLimit: "04:00:00",
	});
	expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
	expect(script).toContain("--name 'it'\"'\"'s a test' \\\n");
	expect(script).toContain("--tasks 3 \\\n");
	expect(script.trimEnd().endsWith("design.qcd sweep.json")).toBe(true);
});

import { invoke } from "@tauri-apps/api/core";
import { basename, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { getDotRadius, type CellArchitecture } from "./CellArchitecture";
import type { Layer } from "./Layer";
import type { SimulationModel } from "./SimulationModel";
import { lastDirectoryManager } from "./last-directory";

export const MODEL_PARAMETERS_FORMAT = "qcaforge-model-parameters";
export const MODEL_PARAMETERS_FORMAT_VERSION = 1;

export type ParameterGroup = "geometry" | "model" | "clock";

/**
 * A numeric design or simulation parameter. `id` is shared with the
 * robustness analysis backend and QCASim's `scripts/model_params.py`:
 * `geometry.cell_size`, `geometry.dot_radius`, `geometry.dot_diameter`,
 * `geometry.layer_z:<layer>`, `geometry.cell_offset_x:<label>`,
 * `geometry.cell_offset_y:<label>`, `model.<key>` and `clock.<key>`.
 */
export interface ParameterDescriptor {
	id: string;
	group: ParameterGroup;
	key: string;
	name: string;
	description?: string;
	unit?: string;
	min?: number;
	max?: number;
	whole_num: boolean;
	value: number;
}

export const PARAMETER_GROUP_NAMES: Record<ParameterGroup, string> = {
	geometry: "Geometry",
	model: "Model settings",
	clock: "Clock generator settings",
};

function optionParameters(
	group: "model" | "clock",
	optionList: any[] | undefined,
	settings: any,
	defaults: any,
): ParameterDescriptor[] {
	return (optionList ?? [])
		.filter(
			(option) =>
				option.type === "Input" &&
				option.descriptor?.type === "NumberInput",
		)
		.map((option) => ({
			id: `${group}.${option.unique_id}`,
			group,
			key: option.unique_id,
			name: option.name,
			description: option.description || undefined,
			unit: option.descriptor.unit ?? undefined,
			min: option.descriptor.min ?? undefined,
			max: option.descriptor.max ?? undefined,
			whole_num: !!option.descriptor.whole_num,
			value: Number(
				settings?.[option.unique_id] ?? defaults?.[option.unique_id],
			),
		}));
}

/**
 * Every numeric parameter of a design and its simulation model: cell
 * geometry, model settings and clock generator settings.
 */
export function collectParameters(
	layers: Layer[],
	cellArchitectures: Map<string, CellArchitecture>,
	model: SimulationModel | undefined,
	modelSettings: any = model?.model_settings,
	clockSettings: any = model?.clock_generator_settings,
): ParameterDescriptor[] {
	const parameters: ParameterDescriptor[] = [];
	const architecture = layers.length
		? cellArchitectures.get(layers[0].cell_architecture_id)
		: undefined;

	if (architecture) {
		parameters.push(
			{
				id: "geometry.cell_size",
				group: "geometry",
				key: "cell_size",
				name: "Cell size (intercell distance)",
				description:
					"Side length of a cell; cell positions are scaled with it.",
				unit: "nm",
				min: 0,
				whole_num: false,
				value: architecture.side_length,
			},
			{
				id: "geometry.dot_radius",
				group: "geometry",
				key: "dot_radius",
				name: "Quantum dot placement radius",
				description:
					"Distance of the quantum dots from the cell center.",
				unit: "nm",
				min: 0,
				whole_num: false,
				value: getDotRadius(architecture),
			},
			{
				id: "geometry.dot_diameter",
				group: "geometry",
				key: "dot_diameter",
				name: "Quantum dot diameter",
				unit: "nm",
				min: 0,
				whole_num: false,
				value: architecture.dot_diameter,
			},
		);
	}

	layers.forEach((layer, i) => {
		parameters.push({
			id: `geometry.layer_z:${i}`,
			group: "geometry",
			key: `layer_z:${i}`,
			name: `Layer "${layer.name}" z-position`,
			unit: "nm",
			whole_num: false,
			value: layer.z_position,
		});
	});

	const labels = [
		...new Set(
			layers.flatMap((layer) =>
				layer.cells
					.map((cell) => cell.label)
					.filter((label): label is string => !!label),
			),
		),
	];
	for (const label of labels) {
		for (const axis of ["x", "y"]) {
			parameters.push({
				id: `geometry.cell_offset_${axis}:${label}`,
				group: "geometry",
				key: `cell_offset_${axis}:${label}`,
				name: `Cell "${label}" ${axis}-offset`,
				description: `Displacement of the cell labelled "${label}" along ${axis} from its designed position.`,
				unit: "nm",
				whole_num: false,
				value: 0,
			});
		}
	}

	if (model) {
		parameters.push(
			...optionParameters(
				"model",
				model.model_option_list,
				modelSettings,
				model.model_settings,
			),
			...optionParameters(
				"clock",
				model.clock_generator_option_list,
				clockSettings,
				model.clock_generator_settings,
			),
		);
	}
	return parameters;
}

export function formatParameterLabel(parameter: {
	name: string;
	unit?: string;
}): string {
	return parameter.unit
		? `${parameter.name} (${parameter.unit})`
		: parameter.name;
}

/**
 * Exports all parameters of the selected model (plus the design geometry
 * they act on) as JSON for QCASim's analysis scripts.
 */
export function buildModelParametersExport(
	layers: Layer[],
	cellArchitectures: Map<string, CellArchitecture>,
	model: SimulationModel,
	qcaCoreVersion: string,
	designFile: string | undefined,
) {
	const usedArchitectureIds = [
		...new Set(layers.map((layer) => layer.cell_architecture_id)),
	];
	return {
		format: MODEL_PARAMETERS_FORMAT,
		version: MODEL_PARAMETERS_FORMAT_VERSION,
		exported_at: new Date().toISOString(),
		qca_core_version: qcaCoreVersion,
		design_file: designFile ?? null,
		model: { id: model.id, name: model.name },
		parameters: collectParameters(layers, cellArchitectures, model),
		model_settings: model.model_settings,
		clock_generator_settings: model.clock_generator_settings,
		cell_architectures: Object.fromEntries(
			usedArchitectureIds
				.filter((id) => cellArchitectures.has(id))
				.map((id) => [id, cellArchitectures.get(id)]),
		),
	};
}

export async function exportModelParameters(
	layers: Layer[],
	cellArchitectures: Map<string, CellArchitecture>,
	model: SimulationModel,
	designFile: string | undefined,
): Promise<string | undefined> {
	const designName = designFile
		? (await basename(designFile)).replace(/\.[^./\\]+$/, "")
		: "design";
	const defaultName = `${designName}_${model.id}_parameters.json`;
	const dir = await lastDirectoryManager.getDirectory("design");
	const filename = await save({
		defaultPath: dir ? await join(dir, defaultName) : defaultName,
		title: "Export model parameters",
		filters: [{ name: "JSON", extensions: ["json"] }],
	});
	if (!filename) return undefined;

	const qcaCoreVersion = (await invoke("get_sim_version")) as string;
	const content = buildModelParametersExport(
		layers,
		cellArchitectures,
		model,
		qcaCoreVersion,
		designFile,
	);
	await writeTextFile(filename, JSON.stringify(content, null, 2));
	return filename;
}

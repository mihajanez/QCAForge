<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { get } from "svelte/store";
	import { listen, type UnlistenFn } from "@tauri-apps/api/event";
	import { basename, dirname, join } from "@tauri-apps/api/path";
	import { open, save } from "@tauri-apps/plugin-dialog";
	import {
		mkdir,
		readTextFile,
		writeFile,
		writeTextFile,
	} from "@tauri-apps/plugin-fs";
	import {
		getCurrentWindow,
		ProgressBarStatus,
	} from "@tauri-apps/api/window";
	import { toast } from "svelte-sonner";
	import Icon from "@iconify/svelte";
	import * as Accordion from "$lib/components/ui/accordion";
	import * as Resizable from "$lib/components/ui/resizable";
	import * as Select from "$lib/components/ui/select";
	import { Button } from "$lib/components/ui/button";
	import { Checkbox } from "$lib/components/ui/checkbox";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Progress } from "$lib/components/ui/progress";
	import { ScrollArea } from "$lib/components/ui/scroll-area";
	import {
		design_filename,
		designSnapshotProvider,
	} from "$lib/globals";
	import { lastDirectoryManager } from "$lib/last-directory";
	import {
		loadDesignFromFile,
		serializeQCADesignFile,
		type QCADesign,
		type QCADesignFile,
	} from "$lib/qca-design";
	import {
		loadSimulationModels,
		type SimulationModel,
	} from "$lib/SimulationModel";
	import {
		collectParameters,
		exportModelParameters,
		formatParameterLabel,
		type ParameterDescriptor,
	} from "$lib/model-parameters";
	import { EVENT_EXPORT_FIGURE } from "$lib/utils/events";
	import { AppControl } from "$lib/utils/app-control";
	import AccuracyPlot from "./accuracy-plot.svelte";
	import PointDetails from "./point-details.svelte";
	import SweepAxisInput, {
		defaultRange,
		type SweepAxisState,
	} from "./sweep-axis-input.svelte";
	import {
		COLOR_SCHEMES,
		renderAccuracyPlotSvg,
		svgToPng,
		type ColorScheme,
		type PlotMode,
	} from "./accuracy-plot";
	import {
		buildGrid,
		cancelRobustnessAnalysis,
		CLUSTER_CONFIG_FILE,
		CLUSTER_DESIGN_FILE,
		CLUSTER_README_FILE,
		CLUSTER_SUBMIT_FILE,
		clusterConfig,
		clusterReadme,
		clusterSubmitScript,
		defaultClusterTasks,
		mergeRunFiles,
		DEFAULT_THRESHOLDS,
		EVENT_ROBUSTNESS_POINT,
		EVENT_ROBUSTNESS_PROGRESS,
		EXPECTED_BEHAVIORS,
		formatAxisLabel,
		getStoredColumns,
		mergeCsvFiles,
		parseRunJson,
		rangeValues,
		ROBUSTNESS_RUN_FORMAT,
		ROBUSTNESS_RUN_JSON,
		ROBUSTNESS_RUN_VERSION,
		runRobustnessAnalysis,
		runToCsv,
		summarizeRun,
		TRUTH_ANALYSIS_CSV,
		validateColumns,
		type AxisInfo,
		type ExpectedBehavior,
		type RobustnessConfig,
		type RobustnessProgress,
		type RobustnessRun,
		type SweepPoint,
	} from "./robustness";

	interface Props {
		/** Whether the robustness route is currently shown. */
		active: boolean;
	}
	let { active }: Props = $props();

	// ----- Design source -----------------------------------------------------
	let models: SimulationModel[] = $state([]);
	let source: "current" | "file" = $state("current");
	let sourceFile: string | undefined = $state();
	let snapshot: QCADesignFile | undefined = $state.raw();
	let snapshotName = $state("");
	let snapshotError: string | undefined = $state();

	const modelId = $derived(
		snapshot?.design.simulation_settings.selected_simulation_model_id,
	);

	/** The selected model with the design's settings merged over its defaults. */
	const effectiveModel: SimulationModel | undefined = $derived.by(() => {
		const model = models.find((m) => m.id === modelId);
		if (!model || !snapshot) return undefined;
		const settings =
			snapshot.design.simulation_settings.simulation_model_settings.get(
				model.id,
			) as any;
		return {
			...model,
			model_settings: {
				...model.model_settings,
				...(settings?.model_settings ?? {}),
			},
			clock_generator_settings: {
				...model.clock_generator_settings,
				...(settings?.clock_generator_settings ?? {}),
			},
		};
	});

	const parameters: ParameterDescriptor[] = $derived(
		snapshot
			? collectParameters(
					snapshot.design.layers,
					snapshot.design.cell_architectures,
					effectiveModel,
				)
			: [],
	);
	const columns = $derived(snapshot ? getStoredColumns(snapshot.design) : []);

	async function refreshSnapshot() {
		snapshotError = undefined;
		try {
			if (source === "current") {
				const provider = get(designSnapshotProvider);
				if (!provider) {
					snapshot = undefined;
					snapshotName = "";
					return;
				}
				snapshot = await provider();
				const filename = get(design_filename);
				snapshotName = filename
					? await basename(filename)
					: "New design (unsaved)";
			} else if (sourceFile) {
				const file = await loadDesignFromFile(sourceFile);
				const settings = file.design.simulation_settings;
				settings.use_custom_input_sequence ??= false;
				settings.custom_input_sequence ??= [];
				snapshot = file;
				snapshotName = await basename(sourceFile);
			}
		} catch (error) {
			snapshot = undefined;
			snapshotError = String(error);
		}
	}

	async function chooseDesignFile() {
		const dir = await lastDirectoryManager.getDirectory("design");
		const filename = await open({
			title: "Analyze design",
			filters: [{ name: "Design", extensions: ["qcd"] }],
			defaultPath: dir,
		});
		if (!filename) return;
		source = "file";
		sourceFile = filename as string;
		await refreshSnapshot();
	}

	// Pick up edits made in the Design view whenever this view is shown.
	$effect(() => {
		if (active && source === "current" && !running) refreshSnapshot();
	});

	// ----- Sweep configuration ----------------------------------------------
	let xAxis: SweepAxisState = $state({
		parameter: "",
		start: 0,
		stop: 0,
		step: 1,
	});
	let yAxis: SweepAxisState = $state({
		parameter: "",
		start: 0,
		stop: 0,
		step: 1,
	});
	let useYAxis = $state(true);
	let expectedBehavior: ExpectedBehavior = $state("reference");
	let cellDelays: Record<string, number> = $state({});
	let thresholds = $state({ ...DEFAULT_THRESHOLDS });
	let keepFiles = $state(false);
	let outputDir: string | undefined = $state();
	let maxThreads = $state(
		typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4,
	);

	// Keep the chosen axes when the design changes, but fall back to the
	// scripts' classic sweep (cell size vs. dot radius) for new designs.
	$effect(() => {
		if (parameters.length === 0) return;
		const pick = (current: string, preferred: string, avoid: string) => {
			if (parameters.some((p) => p.id === current)) return undefined;
			return (
				parameters.find((p) => p.id === preferred && p.id !== avoid) ??
				parameters.find((p) => p.id !== avoid)
			);
		};
		const x = pick(xAxis.parameter, "geometry.cell_size", yAxis.parameter);
		if (x) xAxis = { parameter: x.id, ...defaultRange(x) };
		const y = pick(yAxis.parameter, "geometry.dot_radius", xAxis.parameter);
		if (y) yAxis = { parameter: y.id, ...defaultRange(y) };
	});

	function axisValues(axis: SweepAxisState): number[] | string {
		const parameter = parameters.find((p) => p.id === axis.parameter);
		if (!parameter) return "Select a parameter.";
		return rangeValues(axis.start, axis.stop, axis.step, parameter.whole_num);
	}

	const xValues = $derived(axisValues(xAxis));
	const yValues = $derived(useYAxis ? axisValues(yAxis) : [0]);
	const totalPoints = $derived(
		typeof xValues === "string" || typeof yValues === "string"
			? 0
			: xValues.length * yValues.length,
	);

	/** Problems that prevent both a local run and a cluster export. */
	const sweepErrors: string[] = $derived.by(() => {
		const errors: string[] = [];
		if (!snapshot) {
			errors.push(
				source === "current"
					? "Open or create a design first."
					: "Choose a design file.",
			);
			return errors;
		}
		if (!modelId) errors.push("The design has no simulation model selected.");
		else if (!effectiveModel) errors.push(`Unknown simulation model "${modelId}".`);
		if (typeof xValues === "string") errors.push(`Parameter 1: ${xValues}`);
		if (typeof yValues === "string") errors.push(`Parameter 2: ${yValues}`);
		if (useYAxis && xAxis.parameter === yAxis.parameter)
			errors.push("Choose two different parameters.");
		const columnError = validateColumns(expectedBehavior, columns);
		if (columnError) errors.push(columnError);
		return errors;
	});

	const configErrors: string[] = $derived.by(() => {
		const errors = [...sweepErrors];
		if (snapshot && totalPoints > 10_000)
			errors.push("The sweep has more than 10000 points; export it for a cluster instead.");
		if (keepFiles && !outputDir) errors.push("Choose an output folder.");
		return errors;
	});

	async function chooseOutputDir() {
		const dir = await open({
			directory: true,
			title: "Folder for generated designs and simulations",
			defaultPath:
				outputDir ?? (await lastDirectoryManager.getDirectory("robustness")),
		});
		if (dir) outputDir = dir as string;
	}

	async function exportParameters() {
		if (!snapshot || !effectiveModel) return;
		const filename = await exportModelParameters(
			snapshot.design.layers,
			snapshot.design.cell_architectures,
			effectiveModel,
			source === "current" ? get(design_filename) : sourceFile,
		);
		if (filename) toast.success(`Parameters exported to ${filename}`);
	}

	// ----- Running -----------------------------------------------------------
	let running = $state(false);
	let cancelling = $state(false);
	let progress: RobustnessProgress | undefined = $state();
	let runStartedAt = 0;
	let run: RobustnessRun | undefined = $state();
	let selected: { ix: number; iy: number } | undefined = $state();

	function describeAxis(parameterId: string, values: number[], nominal?: number): AxisInfo {
		const parameter = parameters.find((p) => p.id === parameterId);
		return {
			parameter: parameterId,
			name: parameter?.name ?? parameterId,
			unit: parameter?.unit,
			values,
			nominal: nominal ?? parameter?.value,
		};
	}

	/** The snapshot with the selected model's settings completed from its defaults. */
	function designForRun(file: QCADesignFile): QCADesign {
		const settings = new Map(file.design.simulation_settings.simulation_model_settings);
		if (effectiveModel) {
			settings.set(effectiveModel.id, {
				model_settings: effectiveModel.model_settings,
				clock_generator_settings: effectiveModel.clock_generator_settings,
			});
		}
		return {
			...file.design,
			simulation_settings: {
				...file.design.simulation_settings,
				simulation_model_settings: settings,
			},
		};
	}

	async function designBaseName(): Promise<string> {
		const designFile = source === "current" ? get(design_filename) : sourceFile;
		return designFile
			? (await basename(designFile)).replace(/\.[^./\\]+$/, "")
			: "design";
	}

	async function buildConfig(): Promise<RobustnessConfig> {
		const xs = xValues as number[];
		const ys = useYAxis ? (yValues as number[]) : undefined;
		const baseName = await designBaseName();
		const config: RobustnessConfig = {
			x_axis: { parameter: xAxis.parameter, values: xs },
			y_axis: ys ? { parameter: yAxis.parameter, values: ys } : null,
			expected_behavior: expectedBehavior,
			cell_clock_delays: Object.fromEntries(
				Object.entries(cellDelays).filter(([, delay]) => delay > 0),
			),
			thresholds: { ...thresholds },
			output_dir: keepFiles ? (outputDir ?? null) : null,
			base_name: baseName,
			designer_properties: snapshot?.designer_properties ?? {},
			max_threads: maxThreads > 0 ? maxThreads : null,
		};
		return config;
	}

	async function startAnalysis() {
		await refreshSnapshot();
		if (configErrors.length > 0 || !snapshot) {
			toast.error(configErrors[0] ?? "Invalid configuration");
			return;
		}
		const xs = xValues as number[];
		const ys = useYAxis ? (yValues as number[]) : undefined;
		const config = await buildConfig();

		run = {
			format: ROBUSTNESS_RUN_FORMAT,
			version: ROBUSTNESS_RUN_VERSION,
			name: snapshotName,
			created_at: new Date().toISOString(),
			model_id: modelId,
			x: describeAxis(xAxis.parameter, xs),
			y: ys ? describeAxis(yAxis.parameter, ys) : null,
			expected_behavior: expectedBehavior,
			config,
			columns: [...columns],
			reference_truth_table: null,
			points: [],
			cancelled: false,
			duration_ms: 0,
		};
		selected = undefined;
		running = true;
		cancelling = false;
		progress = { completed: 0, total: totalPoints, fraction: 0 };
		runStartedAt = Date.now();

		const appWindow = getCurrentWindow();
		const unlisteners: UnlistenFn[] = await Promise.all([
			listen<RobustnessProgress>(EVENT_ROBUSTNESS_PROGRESS, (event) => {
				progress = event.payload;
				appWindow.setProgressBar({
					status: ProgressBarStatus.Normal,
					progress: Math.round(event.payload.fraction * 100),
				});
			}),
			listen<SweepPoint>(EVENT_ROBUSTNESS_POINT, (event) => {
				run?.points.push(event.payload);
			}),
		]);

		try {
			const result = await runRobustnessAnalysis(designForRun(snapshot), config);
			run = {
				...run,
				x: describeAxis(xAxis.parameter, xs, result.nominal_x),
				y: ys
					? describeAxis(yAxis.parameter, ys, result.nominal_y ?? undefined)
					: null,
				columns: result.columns,
				reference_truth_table: result.reference_truth_table,
				points: result.points,
				cancelled: result.cancelled,
				duration_ms: result.duration_ms,
			};
			if (config.output_dir) {
				lastDirectoryManager.setDirectoryFromFilePath(
					"robustness",
					await join(config.output_dir, ROBUSTNESS_RUN_JSON),
				);
				await writeRunFiles(config.output_dir, run);
			}
			const failed = result.points.filter((p) => p.error).length;
			if (result.cancelled) toast.warning("Robustness analysis cancelled.");
			else if (failed > 0)
				toast.warning(`Analysis finished; ${failed} point(s) failed.`);
			else toast.success("Robustness analysis finished.");
			AppControl.sendSystemNotification(
				"Robustness analysis",
				result.cancelled
					? "The analysis was cancelled."
					: "The robustness analysis has finished.",
			);
			appWindow.setProgressBar({ status: ProgressBarStatus.None });
		} catch (error) {
			toast.error(`Robustness analysis failed: ${error}`);
			appWindow.setProgressBar({ status: ProgressBarStatus.Error });
		} finally {
			unlisteners.forEach((unlisten) => unlisten());
			running = false;
			cancelling = false;
		}
	}

	// ----- Cluster (HPC) export ---------------------------------------------
	let clusterCpus = $state(16);
	let clusterTasks = $state(0);
	let clusterPartition = $state("amd");
	let clusterTime = $state("04:00:00");
	const suggestedTasks = $derived(defaultClusterTasks(totalPoints, clusterCpus));
	const clusterErrors: string[] = $derived.by(() => {
		const errors = [...sweepErrors];
		if (!(clusterCpus >= 1)) errors.push("Choose at least one CPU per task.");
		if (!/^(\d+-)?\d{1,2}(:\d{2}){0,2}$/.test(clusterTime.trim()))
			errors.push("Time limit must look like 04:00:00 or 1-00:00:00.");
		return errors;
	});

	/**
	 * Writes a folder with the design, the sweep configuration and a submit
	 * script for `hpc/frida/submit-sweep.sh` of QCASim (Slurm job array).
	 */
	async function exportClusterJob() {
		await refreshSnapshot();
		if (clusterErrors.length > 0 || !snapshot) {
			toast.error(clusterErrors[0] ?? "Invalid configuration");
			return;
		}
		const parent = await open({
			directory: true,
			// The job is written into a new subfolder of the chosen folder.
			recursive: true,
			title: "Folder in which to create the cluster job",
			defaultPath: await lastDirectoryManager.getDirectory("robustness"),
		});
		if (!parent) return;
		const name = await designBaseName();
		const xName = xAxis.parameter.split(/[.:]/).pop();
		const yName = useYAxis ? "-" + yAxis.parameter.split(/[.:]/).pop() : "";
		const dir = await join(parent as string, `${name}-${xName}${yName}`);
		const tasks = clusterTasks > 0 ? Math.min(clusterTasks, totalPoints) : suggestedTasks;
		const options = {
			name,
			points: totalPoints,
			cpusPerTask: Math.round(clusterCpus),
			tasks,
			partition: clusterPartition.trim() || "amd",
			timeLimit: clusterTime.trim(),
		};
		try {
			await mkdir(dir, { recursive: true });
			const config = await buildConfig();
			await writeTextFile(
				await join(dir, CLUSTER_DESIGN_FILE),
				serializeQCADesignFile({ ...snapshot, design: designForRun(snapshot) }),
			);
			await writeTextFile(
				await join(dir, CLUSTER_CONFIG_FILE),
				JSON.stringify(clusterConfig(config), null, 2) + "\n",
			);
			await writeTextFile(await join(dir, CLUSTER_SUBMIT_FILE), clusterSubmitScript(options));
			await writeTextFile(await join(dir, CLUSTER_README_FILE), clusterReadme(options));
			lastDirectoryManager.setDirectoryFromFilePath(
				"robustness",
				await join(dir, CLUSTER_SUBMIT_FILE),
			);
			toast.success(
				`Cluster job written to ${dir}: ${totalPoints} points in ${tasks} task(s). Copy the folder to the cluster and run ./submit.sh there.`,
			);
		} catch (error) {
			toast.error(`Could not write the cluster job: ${error}`);
		}
	}

	async function cancelAnalysis() {
		cancelling = true;
		await cancelRobustnessAnalysis();
	}

	const eta = $derived.by(() => {
		if (!progress || progress.fraction <= 0.01) return undefined;
		const elapsed = (Date.now() - runStartedAt) / 1000;
		return Math.round((elapsed / progress.fraction) * (1 - progress.fraction));
	});

	// ----- Results I/O -------------------------------------------------------
	async function writeRunFiles(dir: string, data: RobustnessRun) {
		await writeTextFile(
			await join(dir, ROBUSTNESS_RUN_JSON),
			JSON.stringify(data, null, 2),
		);
		await writeTextFile(await join(dir, TRUTH_ANALYSIS_CSV), runToCsv(data));
	}

	async function saveResults() {
		if (!run) return;
		const dir = await lastDirectoryManager.getDirectory("robustness");
		const filename = await save({
			title: "Save robustness analysis",
			defaultPath: dir ? await join(dir, ROBUSTNESS_RUN_JSON) : ROBUSTNESS_RUN_JSON,
			filters: [
				{ name: "Robustness analysis", extensions: ["json"] },
				{ name: "Truth analysis CSV (QCASim scripts)", extensions: ["csv"] },
			],
		});
		if (!filename) return;
		const content = filename.toLowerCase().endsWith(".csv")
			? runToCsv(run)
			: JSON.stringify(run, null, 2);
		await writeTextFile(filename, content);
		lastDirectoryManager.setDirectoryFromFilePath("robustness", filename);
		toast.success(`Saved ${await basename(filename)}`);
	}

	async function openResults() {
		const dir = await lastDirectoryManager.getDirectory("robustness");
		const selection = await open({
			title: "Open robustness analysis",
			multiple: true,
			defaultPath: dir,
			filters: [
				{ name: "Robustness analysis / truth_analysis.csv", extensions: ["json", "csv"] },
			],
		});
		const files = (Array.isArray(selection) ? selection : selection ? [selection] : []) as string[];
		if (files.length === 0) return;
		try {
			const csvFiles = files.filter((f) => f.toLowerCase().endsWith(".csv"));
			if (csvFiles.length > 0) {
				// Several CSV files are merged like visualize_truth.py does.
				const contents = await Promise.all(
					csvFiles.map(async (f) => ({
						name: await basename(await dirname(f)) + "/" + (await basename(f)),
						content: await readTextFile(f),
					})),
				);
				const { run: merged, warnings } = mergeCsvFiles(contents);
				warnings.forEach((w) => toast.warning(w));
				run = merged;
			} else if (files.length > 1) {
				// Partial results of the tasks of a cluster job array.
				const contents = await Promise.all(files.map((f) => readTextFile(f)));
				const first = parseRunJson(contents[0]);
				const merged = await mergeRunFiles(contents, first.name);
				if (merged.missing > 0)
					toast.warning(
						`Merged ${merged.runs} files: ${merged.missing} of ${merged.points + merged.missing} points are still missing.`,
					);
				else toast.success(`Merged ${merged.runs} files (${merged.points} points).`);
				run = merged.run;
			} else {
				run = parseRunJson(await readTextFile(files[0]));
			}
			selected = undefined;
			lastDirectoryManager.setDirectoryFromFilePath("robustness", files[0]);
		} catch (error) {
			toast.error(`Could not open results: ${error}`);
		}
	}

	// ----- Figure --------------------------------------------------------------
	let plotMode: PlotMode = $state("heatmap");
	let colorScheme: ColorScheme = $state("viridis");
	let showValues = $state(false);
	let showNominal = $state(true);
	let xLabelOverride = $state("");
	let yLabelOverride = $state("");
	let figureWidth = $state(800);
	let figureHeight = $state(500);

	const grid = $derived(run ? buildGrid(run) : undefined);
	const xLabel = $derived(xLabelOverride || formatAxisLabel(run?.x) || "x");
	const yLabel = $derived(yLabelOverride || formatAxisLabel(run?.y) || "y");
	const nominal = $derived(
		showNominal && run?.x.nominal !== undefined
			? { x: run.x.nominal, y: run.y?.nominal }
			: undefined,
	);
	const selectedPoint = $derived(
		selected && grid ? grid.points[selected.iy]?.[selected.ix] : undefined,
	);
	const summary = $derived(run ? summarizeRun(run) : undefined);

	async function exportFigure() {
		if (!run || !grid) {
			toast.error("There is no analysis to export.");
			return;
		}
		const dir = await lastDirectoryManager.getDirectory("figure");
		const defaultName = `${run.name.replace(/\.[^./\\]+$/, "")}_robustness.svg`;
		const filename = await save({
			title: "Export figure",
			defaultPath: dir ? await join(dir, defaultName) : defaultName,
			filters: [
				{ name: "SVG image", extensions: ["svg"] },
				{ name: "PNG image", extensions: ["png"] },
			],
		});
		if (!filename) return;
		try {
			const markup = renderAccuracyPlotSvg(figureWidth, figureHeight, {
				grid,
				xLabel,
				yLabel,
				mode: plotMode,
				colorScheme,
				showValues,
				nominal,
			});
			if (filename.toLowerCase().endsWith(".png")) {
				await writeFile(filename, await svgToPng(markup, figureWidth, figureHeight));
			} else {
				await writeTextFile(filename, markup);
			}
			lastDirectoryManager.setDirectoryFromFilePath("figure", filename);
			toast.success(`Figure exported to ${await basename(filename)}`);
		} catch (error) {
			toast.error(`Could not export figure: ${error}`);
		}
	}

	let unlistenExport: UnlistenFn | undefined;
	onMount(async () => {
		models = await loadSimulationModels();
		unlistenExport = await listen(EVENT_EXPORT_FIGURE, () => {
			if (active) exportFigure();
		});
	});
	onDestroy(() => unlistenExport?.());
</script>

<div class="flex h-full w-full flex-col">
	<Resizable.PaneGroup direction="horizontal">
		<!-- Configuration -->
		<Resizable.Pane defaultSize={24} minSize={16}>
			<ScrollArea class="h-full bg-sidebar px-3">
				<Accordion.Root
					type="multiple"
					value={["design", "sweep", "behaviour"]}
				>
					<Accordion.Item value="design">
						<Accordion.Trigger>
							<div class="flex items-center gap-2">
								<Icon icon="material-symbols:design-services-outline" class="h-4 w-4" />
								Design
							</div>
						</Accordion.Trigger>
						<Accordion.Content class="flex flex-col gap-2 p-1">
							<Select.Root
								type="single"
								value={source}
								onValueChange={(v) => {
									source = v as "current" | "file";
									if (source === "file" && !sourceFile) chooseDesignFile();
									else refreshSnapshot();
								}}
								disabled={running}
							>
								<Select.Trigger class="w-full">
									{source === "current" ? "Design open in the Design view" : "Design file"}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="current" label="Design open in the Design view" />
									<Select.Item value="file" label="Design file" />
								</Select.Content>
							</Select.Root>
							<div class="flex items-center gap-2">
								<span class="min-w-0 flex-1 truncate text-sm" title={snapshotName}>
									{snapshotName || "No design"}
								</span>
								{#if source === "file"}
									<Button size="sm" variant="secondary" onclick={chooseDesignFile} disabled={running}>
										Browse…
									</Button>
								{/if}
								<Button
									size="icon"
									variant="ghost"
									title="Reload design"
									onclick={refreshSnapshot}
									disabled={running}
								>
									<Icon icon="material-symbols:refresh" class="h-5 w-5" />
								</Button>
							</div>
							{#if snapshotError}
								<p class="text-xs text-destructive">{snapshotError}</p>
							{/if}
							{#if snapshot}
								<p class="text-xs text-muted-foreground">
									Model: {effectiveModel?.name ?? modelId ?? "none"} ·
									{columns.length} input/output cell{columns.length === 1 ? "" : "s"}
								</p>
								<Button
									size="sm"
									variant="outline"
									onclick={exportParameters}
									disabled={!effectiveModel}
									title="Export every model, clock and geometry parameter as JSON for the QCASim scripts"
								>
									<Icon icon="material-symbols:download" />
									Export model parameters…
								</Button>
							{/if}
						</Accordion.Content>
					</Accordion.Item>

					<Accordion.Item value="sweep">
						<Accordion.Trigger>
							<div class="flex items-center gap-2">
								<Icon icon="material-symbols:tune" class="h-4 w-4" />
								Parameter sweep
							</div>
						</Accordion.Trigger>
						<Accordion.Content class="flex flex-col gap-4 p-1">
							<SweepAxisInput
								id="sweep-x"
								title="Parameter 1 (x axis)"
								{parameters}
								bind:axis={xAxis}
								excludeParameter={useYAxis ? yAxis.parameter : undefined}
								disabled={running}
							/>
							<div class="flex items-center gap-2">
								<Checkbox id="sweep-use-y" bind:checked={useYAxis} disabled={running} />
								<Label for="sweep-use-y">Sweep a second parameter</Label>
							</div>
							{#if useYAxis}
								<SweepAxisInput
									id="sweep-y"
									title="Parameter 2 (y axis)"
									{parameters}
									bind:axis={yAxis}
									excludeParameter={xAxis.parameter}
									disabled={running}
								/>
							{/if}
							<p class="text-sm">
								<b>{totalPoints}</b> simulation{totalPoints === 1 ? "" : "s"}
								{#if expectedBehavior === "reference"}(+1 nominal){/if}
							</p>
						</Accordion.Content>
					</Accordion.Item>

					<Accordion.Item value="behaviour">
						<Accordion.Trigger>
							<div class="flex items-center gap-2">
								<Icon icon="material-symbols:rule" class="h-4 w-4" />
								Expected behaviour
							</div>
						</Accordion.Trigger>
						<Accordion.Content class="flex flex-col gap-3 p-1">
							<Select.Root
								type="single"
								value={expectedBehavior}
								onValueChange={(v) => (expectedBehavior = v as ExpectedBehavior)}
								disabled={running}
							>
								<Select.Trigger class="w-full">
									{EXPECTED_BEHAVIORS.find((b) => b.id === expectedBehavior)?.name}
								</Select.Trigger>
								<Select.Content>
									{#each EXPECTED_BEHAVIORS as behavior}
										<Select.Item value={behavior.id} label={behavior.name} />
									{/each}
								</Select.Content>
							</Select.Root>
							<p class="text-xs text-muted-foreground">
								{EXPECTED_BEHAVIORS.find((b) => b.id === expectedBehavior)?.description}
							</p>
							{#if columns.length > 0}
								<div class="flex flex-col gap-1">
									<p class="text-xs font-medium">
										Truth table columns and output clock delays
									</p>
									{#each columns as column, i}
										<div class="flex items-center gap-2 text-sm">
											<span class="w-5 text-muted-foreground">{i + 1}.</span>
											<span class="flex-1 truncate">
												{column.label}
												<span class="text-xs text-muted-foreground">
													{column.is_output ? "output" : "input"}
												</span>
											</span>
											<Input
												type="number"
												min="0"
												step="1"
												class="h-7 w-16 px-1 text-xs"
												title="Clock delay (cycles to skip) for this cell"
												value={cellDelays[column.label] ?? 0}
												onchange={(e) => {
													const v = Math.max(
														0,
														Math.round(
															parseFloat((e.target as HTMLInputElement).value) || 0,
														),
													);
													cellDelays = { ...cellDelays, [column.label]: v };
												}}
												disabled={running}
											/>
										</div>
									{/each}
								</div>
							{/if}
						</Accordion.Content>
					</Accordion.Item>

					<Accordion.Item value="advanced">
						<Accordion.Trigger>
							<div class="flex items-center gap-2">
								<Icon icon="material-symbols:settings" class="h-4 w-4" />
								Analysis settings
							</div>
						</Accordion.Trigger>
						<Accordion.Content class="flex flex-col gap-3 p-1">
							<div class="grid grid-cols-3 gap-2">
								<div class="flex flex-col gap-1">
									<Label for="th-clock" class="text-xs">Clock threshold</Label>
									<Input id="th-clock" type="number" step="0.01" min="0" max="1" class="h-8 px-2" bind:value={thresholds.clock} disabled={running} />
								</div>
								<div class="flex flex-col gap-1">
									<Label for="th-cell" class="text-xs">Cell threshold</Label>
									<Input id="th-cell" type="number" step="0.01" min="0" max="1" class="h-8 px-2" bind:value={thresholds.logical} disabled={running} />
								</div>
								<div class="flex flex-col gap-1">
									<Label for="th-value" class="text-xs">Value threshold</Label>
									<Input id="th-value" type="number" step="0.05" min="0" max="1" class="h-8 px-2" bind:value={thresholds.value} disabled={running} />
								</div>
							</div>
							<div class="flex items-center gap-2">
								<Label for="threads" class="flex-1 text-sm">Parallel simulations</Label>
								<Input id="threads" type="number" min="1" step="1" class="h-8 w-20 px-2" bind:value={maxThreads} disabled={running} />
							</div>
							<div class="flex items-center gap-2">
								<Checkbox id="keep-files" bind:checked={keepFiles} disabled={running} />
								<Label for="keep-files">Keep generated designs and simulations</Label>
							</div>
							{#if keepFiles}
								<div class="flex items-center gap-2">
									<span class="min-w-0 flex-1 truncate text-xs" title={outputDir}>
										{outputDir ?? "No folder selected"}
									</span>
									<Button size="sm" variant="secondary" onclick={chooseOutputDir} disabled={running}>
										Browse…
									</Button>
								</div>
								<p class="text-xs text-muted-foreground">
									Writes <code>name_x_y.qcd/.qcs</code>, <code>{TRUTH_ANALYSIS_CSV}</code>
									and <code>{ROBUSTNESS_RUN_JSON}</code>, usable with the QCASim scripts.
								</p>
							{/if}
						</Accordion.Content>
					</Accordion.Item>

					<Accordion.Item value="cluster">
						<Accordion.Trigger>
							<div class="flex items-center gap-2">
								<Icon icon="material-symbols:dns-outline" class="h-4 w-4" />
								Cluster (HPC)
							</div>
						</Accordion.Trigger>
						<Accordion.Content class="flex flex-col gap-3 p-1">
							<p class="text-xs text-muted-foreground">
								Export the sweep as a Slurm job array, e.g. for the FRIDA cluster.
								Each task simulates every N-th point; the partial results are merged
								into one run file that opens here.
							</p>
							<div class="grid grid-cols-2 gap-2">
								<div class="flex flex-col gap-1">
									<Label for="hpc-cpus" class="text-xs">CPUs per task</Label>
									<Input id="hpc-cpus" type="number" min="1" step="1" class="h-8 px-2" bind:value={clusterCpus} />
								</div>
								<div class="flex flex-col gap-1">
									<Label for="hpc-tasks" class="text-xs">Tasks (0 = {suggestedTasks})</Label>
									<Input id="hpc-tasks" type="number" min="0" step="1" class="h-8 px-2" bind:value={clusterTasks} />
								</div>
								<div class="flex flex-col gap-1">
									<Label for="hpc-partition" class="text-xs">Partition</Label>
									<Input id="hpc-partition" class="h-8 px-2" bind:value={clusterPartition} />
								</div>
								<div class="flex flex-col gap-1">
									<Label for="hpc-time" class="text-xs">Time limit per task</Label>
									<Input id="hpc-time" class="h-8 px-2" bind:value={clusterTime} />
								</div>
							</div>
							{#if clusterErrors.length > 0}
								<p class="text-xs text-destructive">{clusterErrors[0]}</p>
							{/if}
							<Button
								size="sm"
								variant="outline"
								onclick={exportClusterJob}
								disabled={clusterErrors.length > 0 || running}
								title="Write design.qcd, sweep.json and submit.sh for hpc/frida/submit-sweep.sh (QCASim)"
							>
								<Icon icon="material-symbols:upload" />
								Export for cluster…
							</Button>
						</Accordion.Content>
					</Accordion.Item>

					<Accordion.Item value="figure">
						<Accordion.Trigger>
							<div class="flex items-center gap-2">
								<Icon icon="material-symbols:image-outline" class="h-4 w-4" />
								Figure
							</div>
						</Accordion.Trigger>
						<Accordion.Content class="flex flex-col gap-3 p-1">
							<div class="flex flex-col gap-1">
								<Label for="fig-x" class="text-xs">X axis label</Label>
								<Input id="fig-x" class="h-8 px-2" placeholder={formatAxisLabel(run?.x) || "x"} bind:value={xLabelOverride} />
							</div>
							<div class="flex flex-col gap-1">
								<Label for="fig-y" class="text-xs">Y axis label</Label>
								<Input id="fig-y" class="h-8 px-2" placeholder={formatAxisLabel(run?.y) || "y"} bind:value={yLabelOverride} />
							</div>
							<div class="grid grid-cols-2 gap-2">
								<div class="flex flex-col gap-1">
									<Label for="fig-w" class="text-xs">Export width (px)</Label>
									<Input id="fig-w" type="number" min="200" step="10" class="h-8 px-2" bind:value={figureWidth} />
								</div>
								<div class="flex flex-col gap-1">
									<Label for="fig-h" class="text-xs">Export height (px)</Label>
									<Input id="fig-h" type="number" min="150" step="10" class="h-8 px-2" bind:value={figureHeight} />
								</div>
							</div>
						</Accordion.Content>
					</Accordion.Item>
				</Accordion.Root>

				<div class="sticky bottom-0 flex flex-col gap-2 bg-sidebar py-3">
					{#if configErrors.length > 0 && !running}
						<ul class="list-disc pl-4 text-xs text-destructive">
							{#each configErrors as error}
								<li>{error}</li>
							{/each}
						</ul>
					{/if}
					{#if running}
						<Progress value={(progress?.fraction ?? 0) * 100} class="h-2" />
						<p class="text-xs text-muted-foreground">
							{progress?.completed ?? 0} / {progress?.total ?? totalPoints} simulations
							{#if eta !== undefined}· about {eta} s left{/if}
						</p>
						<Button variant="destructive" onclick={cancelAnalysis} disabled={cancelling}>
							<Icon icon="material-symbols:stop" class="h-5 w-5" />
							{cancelling ? "Cancelling…" : "Cancel"}
						</Button>
					{:else}
						<Button onclick={startAnalysis} disabled={configErrors.length > 0}>
							<Icon icon="material-symbols:play-arrow" class="h-5 w-5" />
							Run robustness analysis
						</Button>
					{/if}
				</div>
			</ScrollArea>
		</Resizable.Pane>
		<Resizable.Handle />

		<!-- Plot -->
		<Resizable.Pane minSize={30}>
			<div class="flex h-full flex-col">
				<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
					<div class="mr-auto min-w-0">
						<p class="truncate font-semibold" title={run?.name}>
							{run ? run.name : "Robustness analysis"}
						</p>
						{#if run && summary}
							<p class="text-xs text-muted-foreground">
								{#if run.expected_behavior}
									{EXPECTED_BEHAVIORS.find((b) => b.id === run?.expected_behavior)?.name} ·
								{/if}
								{summary.count} point{summary.count === 1 ? "" : "s"}
								{#if summary.mean !== undefined}
									· mean {(summary.mean * 100).toFixed(1)} %
									· {summary.fullyCorrect} fully correct
								{/if}
								{#if summary.failed > 0}
									· <span class="text-destructive">{summary.failed} failed</span>
								{/if}
								{#if run.cancelled}· cancelled{/if}
							</p>
						{/if}
					</div>
					{#if run?.y}
						<Select.Root
							type="single"
							value={plotMode}
							onValueChange={(v) => (plotMode = v as PlotMode)}
						>
							<Select.Trigger class="h-8 w-28">
								{plotMode === "heatmap" ? "Heatmap" : "Contour"}
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="heatmap" label="Heatmap" />
								<Select.Item value="contour" label="Contour" />
							</Select.Content>
						</Select.Root>
					{/if}
					<Select.Root
						type="single"
						value={colorScheme}
						onValueChange={(v) => (colorScheme = v as ColorScheme)}
					>
						<Select.Trigger class="h-8 w-28">{colorScheme}</Select.Trigger>
						<Select.Content>
							{#each Object.keys(COLOR_SCHEMES) as scheme}
								<Select.Item value={scheme} label={scheme} />
							{/each}
						</Select.Content>
					</Select.Root>
					{#if run?.y}
						<div class="flex items-center gap-1">
							<Checkbox id="show-values" bind:checked={showValues} />
							<Label for="show-values" class="text-xs">Values</Label>
						</div>
					{/if}
					<div class="flex items-center gap-1">
						<Checkbox id="show-nominal" bind:checked={showNominal} />
						<Label for="show-nominal" class="text-xs">Nominal</Label>
					</div>
					<Button size="icon" variant="ghost" title="Open results (JSON or truth_analysis.csv); several JSON files of one sweep are merged" onclick={openResults} disabled={running}>
						<Icon icon="material-symbols:folder-open-outline" class="h-5 w-5" />
					</Button>
					<Button size="icon" variant="ghost" title="Save results (JSON or CSV)" onclick={saveResults} disabled={!run || running}>
						<Icon icon="material-symbols:save-outline" class="h-5 w-5" />
					</Button>
					<Button size="icon" variant="ghost" title="Export figure (Ctrl+E)" onclick={exportFigure} disabled={!run}>
						<Icon icon="material-symbols:imagesmode-outline" class="h-5 w-5" />
					</Button>
				</div>
				<div class="min-h-0 flex-1 p-2">
					{#if run && grid}
						<AccuracyPlot
							{grid}
							{xLabel}
							{yLabel}
							mode={plotMode}
							{colorScheme}
							{showValues}
							{nominal}
							{selected}
							onSelect={(ix, iy) => (selected = { ix, iy })}
						/>
					{:else}
						<div class="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
							<Icon icon="material-symbols:grid-on-outline" class="h-12 w-12" />
							<p>Configure a parameter sweep and run the analysis,</p>
							<p class="text-sm">
								or open a saved analysis or a <code>{TRUTH_ANALYSIS_CSV}</code> from the QCASim scripts.
							</p>
						</div>
					{/if}
				</div>
			</div>
		</Resizable.Pane>
		<Resizable.Handle />

		<!-- Details -->
		<Resizable.Pane defaultSize={24} minSize={14}>
			<ScrollArea class="h-full bg-sidebar p-3">
				<p class="mb-2 font-semibold">Selected point</p>
				{#if run}
					<PointDetails {run} point={selectedPoint} />
				{:else}
					<p class="text-sm text-muted-foreground">No analysis loaded.</p>
				{/if}
			</ScrollArea>
		</Resizable.Pane>
	</Resizable.PaneGroup>
</div>

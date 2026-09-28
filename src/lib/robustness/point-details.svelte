<script lang="ts">
	import { emit } from "@tauri-apps/api/event";
	import { revealItemInDir } from "@tauri-apps/plugin-opener";
	import Icon from "@iconify/svelte";
	import { Button } from "$lib/components/ui/button";
	import * as Table from "$lib/components/ui/table/index.js";
	import { EVENT_OPEN_SIMULATION_FILE } from "$lib/utils/events";
	import {
		formatAxisLabel,
		formatNumber,
		type RobustnessRun,
		type SweepPoint,
	} from "./robustness";

	interface Props {
		run: RobustnessRun;
		point: SweepPoint | undefined;
	}

	let { run, point }: Props = $props();

	const isReference = $derived(run.expected_behavior === "reference");

	// C and D are the same logic state (analyze_truth.py's _equivariance).
	function sameState(a: string | null, b: string | null): boolean {
		const norm = (v: string) => (v === "D" ? "C" : v);
		return a !== null && b !== null && norm(a) === norm(b);
	}

	function expectedValue(row: number, column: number): string | null | undefined {
		if (!isReference || !run.columns[column]?.is_output) return undefined;
		return run.reference_truth_table?.rows[row]?.[column];
	}
</script>

{#if !point}
	<p class="text-sm text-muted-foreground">
		Click a point in the plot to inspect its truth table.
	</p>
{:else}
	<div class="flex flex-col gap-3 text-sm">
		<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
			<dt class="text-muted-foreground">{formatAxisLabel(run.x)}</dt>
			<dd>{formatNumber(point.x)}</dd>
			{#if run.y && point.y !== null}
				<dt class="text-muted-foreground">{formatAxisLabel(run.y)}</dt>
				<dd>{formatNumber(point.y)}</dd>
			{/if}
			<dt class="text-muted-foreground">Accuracy</dt>
			<dd class="font-semibold">
				{point.accuracy === null
					? "–"
					: `${(point.accuracy * 100).toFixed(1)} %`}
			</dd>
			{#if point.duration_ms > 0}
				<dt class="text-muted-foreground">Simulation time</dt>
				<dd>{(point.duration_ms / 1000).toFixed(2)} s</dd>
			{/if}
		</dl>

		{#if point.error}
			<p class="rounded-md border border-destructive p-2 text-destructive">
				{point.error}
			</p>
		{/if}

		{#if point.simulation_file}
			<div class="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="secondary"
					onclick={() =>
						emit(EVENT_OPEN_SIMULATION_FILE, point.simulation_file)}
				>
					<Icon icon="material-symbols:search-insights-rounded" />
					Open simulation
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onclick={() => revealItemInDir(point.simulation_file!)}
				>
					<Icon icon="material-symbols:folder-open-outline" />
					Show in folder
				</Button>
			</div>
		{/if}

		{#if point.truth_table && run.columns.length > 0}
			<div class="overflow-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>#</Table.Head>
							{#each run.columns as column}
								<Table.Head
									title={column.is_output ? "Output" : "Input"}
								>
									{column.label}
									<span class="text-xs text-muted-foreground">
										{column.is_output ? "out" : "in"}
									</span>
								</Table.Head>
							{/each}
							<Table.Head>Score</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each point.truth_table.rows as row, r}
							{@const score = point.row_accuracy[r]}
							<Table.Row
								class={score !== undefined && score < 1
									? "bg-destructive/10"
									: ""}
							>
								<Table.Cell>{r}</Table.Cell>
								{#each row as value, c}
									{@const expected = expectedValue(r, c)}
									{@const mismatch =
										expected !== undefined &&
										expected !== null &&
										!sameState(expected, value)}
									<Table.Cell
										class={mismatch
											? "font-semibold text-destructive"
											: ""}
										title={mismatch
											? `Nominal design: ${expected}`
											: undefined}
									>
										{value ?? "NaN"}{#if mismatch}
											<span class="text-xs"> ≠{expected}</span>
										{/if}
									</Table.Cell>
								{/each}
								<Table.Cell>
									{score === undefined ? "" : score.toFixed(2)}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		{/if}
	</div>
{/if}

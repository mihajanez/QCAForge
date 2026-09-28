<script lang="ts" module>
	import type { ParameterDescriptor } from "$lib/model-parameters";

	export interface SweepAxisState {
		parameter: string;
		start: number;
		stop: number;
		step: number;
	}

	/** A sensible initial range around a parameter's nominal value. */
	export function defaultRange(
		parameter: ParameterDescriptor,
	): Omit<SweepAxisState, "parameter"> {
		const nominal = parameter.value;
		if (parameter.whole_num) {
			const start = Math.max(parameter.min ?? 0, Math.round(nominal * 0.5));
			const stop = Math.max(start + 1, Math.round(nominal * 1.5));
			return { start, stop, step: Math.max(1, Math.round((stop - start) / 10)) };
		}
		if (!nominal) return { start: -10, stop: 10, step: 2 };
		const span = Math.abs(nominal) * 0.2;
		const round = (v: number) => Number(v.toPrecision(6));
		return {
			start: round(nominal - span),
			stop: round(nominal + span),
			step: round(span / 5),
		};
	}
</script>

<script lang="ts">
	import * as Select from "$lib/components/ui/select";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import {
		formatParameterLabel,
		PARAMETER_GROUP_NAMES,
		type ParameterGroup,
	} from "$lib/model-parameters";
	import { formatNumber, rangeValues } from "./robustness";

	interface Props {
		id: string;
		title: string;
		parameters: ParameterDescriptor[];
		axis: SweepAxisState;
		excludeParameter?: string;
		disabled?: boolean;
	}

	let {
		id,
		title,
		parameters,
		axis = $bindable(),
		excludeParameter,
		disabled = false,
	}: Props = $props();

	const selected = $derived(parameters.find((p) => p.id === axis.parameter));
	const values = $derived(
		selected
			? rangeValues(axis.start, axis.stop, axis.step, selected.whole_num)
			: undefined,
	);
	const groups = $derived(
		(["geometry", "model", "clock"] as ParameterGroup[])
			.map((group) => ({
				group,
				items: parameters.filter(
					(p) => p.group === group && p.id !== excludeParameter,
				),
			}))
			.filter(({ items }) => items.length > 0),
	);

	function onParameterChange(parameterId: string) {
		const parameter = parameters.find((p) => p.id === parameterId);
		if (!parameter) return;
		axis = { parameter: parameterId, ...defaultRange(parameter) };
	}
</script>

<div class="flex flex-col gap-2">
	<Label for="{id}-parameter">{title}</Label>
	<Select.Root
		type="single"
		value={axis.parameter}
		onValueChange={onParameterChange}
		{disabled}
	>
		<Select.Trigger id="{id}-parameter" class="w-full text-left">
			<span class="truncate">
				{selected ? formatParameterLabel(selected) : "Select parameter"}
			</span>
		</Select.Trigger>
		<Select.Content class="max-h-80">
			{#each groups as { group, items }}
				<Select.Group>
					<Select.GroupHeading>{PARAMETER_GROUP_NAMES[group]}</Select.GroupHeading>
					{#each items as parameter}
						<Select.Item
							value={parameter.id}
							label={formatParameterLabel(parameter)}
						/>
					{/each}
				</Select.Group>
			{/each}
		</Select.Content>
	</Select.Root>

	{#if selected}
		{#if selected.description}
			<p class="text-xs text-muted-foreground">{selected.description}</p>
		{/if}
		<div class="grid grid-cols-3 gap-2">
			{#each [["start", "From"], ["stop", "To"], ["step", "Step"]] as [field, label]}
				<div class="flex flex-col gap-1">
					<Label for="{id}-{field}" class="text-xs text-muted-foreground">
						{label}
					</Label>
					<Input
						id="{id}-{field}"
						type="number"
						step={selected.whole_num ? "1" : "any"}
						class="h-8 px-2"
						bind:value={axis[field as "start" | "stop" | "step"]}
						{disabled}
					/>
				</div>
			{/each}
		</div>
		<p class="text-xs text-muted-foreground">
			Nominal: {formatNumber(selected.value)}{selected.unit
				? ` ${selected.unit}`
				: ""}
			·
			{#if typeof values === "string"}
				<span class="text-destructive">{values}</span>
			{:else if values}
				{values.length} value{values.length === 1 ? "" : "s"}
			{/if}
		</p>
	{/if}
</div>

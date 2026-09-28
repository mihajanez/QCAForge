<script lang="ts">
	import type { SimulationModel } from "$lib/SimulationModel";
	import BaseModal from "./base-modal.svelte";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Button } from "$lib/components/ui/button";

	interface Props {
		isOpen: boolean;
		model: SimulationModel;
		applyCallback: () => void;
		/** Exports all model parameters for the QCASim analysis scripts. */
		onExport?: (model: SimulationModel) => void;
	}

	let {
		isOpen = $bindable(),
		model = $bindable(),
		applyCallback,
		onExport,
	}: Props = $props();

	// Export what is currently entered, even if not applied yet.
	function exportParameters(event: MouseEvent) {
		const form = (event.currentTarget as HTMLButtonElement).form;
		const data: any = form ? Object.fromEntries(new FormData(form)) : {};
		const settings = { ...model.clock_generator_settings };
		model.clock_generator_option_list.forEach((option: any) => {
			if (option.type !== "Input") return;
			if (option.descriptor.type === "NumberInput") {
				const value = parseFloat(data[option.unique_id]);
				if (!isNaN(value)) settings[option.unique_id] = value;
			}
		});
		onExport?.({ ...model, clock_generator_settings: settings });
	}

	function applyModelChanges(data: any) {
		model.clock_generator_option_list.forEach((option: any) => {
			if (option.type !== "Input") return;

			if (option.descriptor.type === "NumberInput") {
				const value = parseFloat(data[option.unique_id]);
				if (!isNaN(value)) {
					model.clock_generator_settings[option.unique_id] = value;
				}
			}
		});
		applyCallback();
	}
</script>

<BaseModal bind:open={isOpen} type="confirm" applyCallback={applyModelChanges}>
	{#snippet title()}
		{model.name} clock generator settings
	{/snippet}
	{#snippet description()}
		Configure clock generator parameters for the selected model.
	{/snippet}
	{#snippet footer()}
		{#if onExport}
			<Button
				type="button"
				variant="outline"
				class="sm:mr-auto"
				title="Export all model, clock generator and geometry parameters as JSON for the QCASim scripts"
				onclick={exportParameters}
			>
				Export parameters…
			</Button>
		{/if}
		<Button type="button" variant="secondary" onclick={() => (isOpen = false)}>
			Cancel
		</Button>
		<Button type="submit">Ok</Button>
	{/snippet}
	<div class="flex flex-col gap-2">
		{#each model.clock_generator_option_list as option}
			{#if option.type === "Header"}
				<p class="text-lg font-bold">{option.label}</p>
			{:else if option.type === "Break"}
				<hr />
			{:else if option.type === "Input"}
				{#if option.descriptor.type === "NumberInput"}
					<div class="flex flex-col gap-1.5">
						<Label for={option.unique_id}>{option.name}</Label>
						<div class="flex items-center gap-2">
							<Input
								type="number"
								value={model.clock_generator_settings[
									option.unique_id
								]}
								name={option.unique_id}
								min={option.descriptor.min}
								max={option.descriptor.max}
								step={option.descriptor.whole_num ? "1" : "any"}
							/>
							{#if option.descriptor.unit}
								<span>{option.descriptor.unit}</span>
							{/if}
						</div>
						{#if option.description}
							<p class="text-xs text-muted-foreground">
								{option.description}
							</p>
						{/if}
					</div>
				{/if}
			{/if}
		{/each}
	</div>
</BaseModal>
